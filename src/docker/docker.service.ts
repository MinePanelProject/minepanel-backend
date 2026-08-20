import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Dockerode from 'dockerode';
import { deferred } from 'src/common/deferred';
import type { Server } from 'src/db/schema';
import {
  DOCKERODE,
  MAX_STOP_TIMEOUT_SECONDS,
  RCON_EXEC_TIMEOUT_MS,
  RCON_MAX_ARG_COUNT,
  RCON_MAX_TOTAL_BYTES,
  STOP_TIMEOUT_SECONDS,
} from './docker.constants';

const MINECRAFT_IMAGE = 'itzg/minecraft-server';
const CONTAINER_PORT = '25565/tcp';
const MIN_MEMORY_MB = 512;

export type ContainerInspectState = {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  restartCount: number;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  oomKilled: boolean;
};

export type HostInfo = { totalRamMb: number | null; cpuCount: number | null };

export type DiskInfo = { totalDiskMb: number | null; freeDiskMb: number | null };

export type DockerConfig = {
  mcDataPath: string;
  mcDataBindSource: string;
  network: string;
  portMin: number;
  portMax: number;
};

export type ManagedContainerLookupResult =
  | { id: string; running: boolean }
  | { unavailable: true }
  | null;
type DockerErrorCandidate = { code?: string; statusCode?: number };
type DockerInfoCandidate = { MemTotal?: number; NCPU?: number };
type DockerInfoInput = DockerInfoCandidate | string | number | boolean | null | undefined;

const isFiniteInteger = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);

const isDockerErrorCandidate = (cause: unknown): cause is DockerErrorCandidate =>
  typeof cause === 'object' && cause !== null;

const isDockerInfo = (value: DockerInfoInput): value is DockerInfoCandidate =>
  typeof value === 'object' && value !== null;

const DAEMON_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EACCES',
  'EPERM',
]);

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

type ContainerSummaryCandidate = { Id?: string; State?: string };

const isNonEmptyString = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

export class RconUnavailableError extends Error {
  constructor(message = 'RCON unavailable') {
    super(message);
    this.name = 'RconUnavailableError';
  }
}

@Injectable()
export class DockerService {
  constructor(
    @Inject(DOCKERODE) private docker: Dockerode,
    private configService: ConfigService,
  ) {}

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();

      return true;
    } catch {
      return false;
    }
  }

  async createContainer(server: Server): Promise<string> {
    const dockerConfig = this.readDockerConfig();
    this.validateServerForCreate(server, dockerConfig);
    const dataDir = this.resolveDataDir(dockerConfig.mcDataBindSource, server.id);
    const env = this.buildEnv(server);

    const config = {
      name: `mc-${server.id}`,
      Image: MINECRAFT_IMAGE,
      ExposedPorts: { [CONTAINER_PORT]: {} },
      Env: env,
      Labels: { 'minepanel.server-id': server.id, 'minepanel.managed': 'true' },
      HostConfig: {
        Binds: [`${dataDir}:/data`],
        Memory: server.memoryLimitMb * 1024 * 1024,
        PortBindings: { [CONTAINER_PORT]: [{ HostPort: String(server.port) }] },
        Privileged: false,
        CapAdd: [],
        NetworkMode: dockerConfig.network,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };

    try {
      const container = await this.docker.createContainer(config);

      return container.id;
    } catch (error) {
      // on create a 404 means a missing image or network, not a missing container
      if (this.isStatusCode(error, 404)) {
        throw new NotFoundException('Docker image or network not found');
      }
      this.handleDockerError(error, 'container');
    }
  }

  async startContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).start();
    } catch (error) {
      if (this.isStatusCode(error, 304)) return;
      this.handleDockerError(error, 'container');
    }
  }

  async stopContainer(
    containerId: string,
    stopTimeoutSeconds = STOP_TIMEOUT_SECONDS,
  ): Promise<'stopped' | 'already-stopped'> {
    if (
      !isFiniteInteger(stopTimeoutSeconds) ||
      stopTimeoutSeconds < 0 ||
      stopTimeoutSeconds > MAX_STOP_TIMEOUT_SECONDS
    ) {
      throw new BadRequestException('Invalid stop timeout');
    }

    try {
      await this.docker.getContainer(containerId).stop({ t: stopTimeoutSeconds });

      return 'stopped';
    } catch (error) {
      if (this.isStatusCode(error, 304)) return 'already-stopped';
      this.handleDockerError(error, 'container');
    }
  }

  async executeRconCommand(containerId: string, command: readonly string[]): Promise<void> {
    this.validateRconCommand(command);

    const abortController = new AbortController();
    const deadline = setTimeout(() => abortController.abort(), RCON_EXEC_TIMEOUT_MS);

    try {
      const exec = await this.docker.getContainer(containerId).exec({
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: ['rcon-cli', ...command],
        abortSignal: abortController.signal,
      });

      // SAFETY: Dockerode Exec.start produces the readable stream contract consumed by
      // drainExecStream: it exposes read data and destroy() for the cleanup path.
      const stream = (await exec.start({
        Detach: false,
        Tty: false,
        abortSignal: abortController.signal,
      })) as Readable;

      try {
        await this.drainExecStream(stream, abortController);
      } finally {
        try {
          stream.destroy();
        } catch {
          // best-effort cleanup; the stream may already be closed
        }
      }

      // SAFETY: Dockerode Exec.inspect produces the terminal-state contract consumed below:
      // Running must be false and ExitCode must be zero before the operation is accepted.
      const result = (await exec.inspect({ abortSignal: abortController.signal })) as {
        Running?: unknown;
        ExitCode?: unknown;
      };

      if (result.Running !== false || result.ExitCode !== 0) {
        throw new RconUnavailableError();
      }
    } catch (error) {
      if (this.isDockerError(error)) {
        this.handleDockerError(error, 'container');
      }

      // local timeout / stream / CLI / exit / malformed-result failures
      throw new RconUnavailableError();
    } finally {
      clearTimeout(deadline);
    }
  }

  private validateRconCommand(command: readonly string[]): void {
    if (!Array.isArray(command) || command.length === 0) {
      throw new RconUnavailableError('RCON command rejected');
    }

    if (command.length > RCON_MAX_ARG_COUNT) {
      throw new RconUnavailableError('RCON command rejected');
    }

    let totalBytes = 0;

    for (const arg of command) {
      if (!isNonEmptyString(arg)) {
        throw new RconUnavailableError('RCON command rejected');
      }

      if (/[\0\r\n]/.test(arg)) {
        throw new RconUnavailableError('RCON command rejected');
      }

      totalBytes += Buffer.byteLength(arg, 'utf8');

      if (totalBytes > RCON_MAX_TOTAL_BYTES) {
        throw new RconUnavailableError('RCON command rejected');
      }
    }
  }

  private async drainExecStream(stream: Readable, abortController: AbortController): Promise<void> {
    const { promise, resolve, reject } = deferred<void>();

    const onAbort = () => {
      try {
        stream.destroy();
      } catch {
        // ignore secondary cleanup errors
      }
      reject(new Error('RCON exec timeout'));
    };

    if (abortController.signal.aborted) {
      onAbort();
      return promise;
    }

    abortController.signal.addEventListener('abort', onAbort, { once: true });

    stream.on('data', () => {
      // discard output; never buffer or log
    });

    stream.on('end', () => {
      abortController.signal.removeEventListener('abort', onAbort);
      resolve();
    });

    stream.on('error', (error: Error) => {
      abortController.signal.removeEventListener('abort', onAbort);
      reject(error);
    });

    return promise;
  }

  async removeContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: false });
    } catch (error) {
      if (this.isStatusCode(error, 404)) return; // already removed, treat as idempotent success
      this.handleDockerError(error, 'container');
    }
  }

  async findManagedContainer(serverId: string): Promise<ManagedContainerLookupResult> {
    try {
      // SAFETY: Dockerode listContainers returns entries with the Id and State fields
      // consumed below.
      const containers = (await this.docker.listContainers({
        all: true,
        filters: { label: [`minepanel.server-id=${serverId}`, 'minepanel.managed=true'] },
      })) as ContainerSummaryCandidate[];

      if (containers.length === 0) {
        return null;
      }

      const container = containers[0];
      const id = isNonEmptyString(container.Id) ? container.Id : '';
      if (!id) {
        Logger.warn('Managed container lookup returned an entry without an id', 'DockerService');
        return null;
      }

      return { id, running: container.State === 'running' };
    } catch (error) {
      if (
        this.isDaemonUnreachable(error) ||
        this.isStatusCode(error, 502) ||
        this.isStatusCode(error, 503) ||
        this.isStatusCode(error, 504)
      ) {
        return { unavailable: true };
      }

      // Any other lookup failure prevents confirming absence, so treat it as
      // unavailable rather than risk deleting a tracked row or orphaning a container.
      return { unavailable: true };
    }
  }

  async inspectContainer(containerId: string): Promise<ContainerInspectState> {
    try {
      // SAFETY: Dockerode Container.inspect produces the container-state contract consumed
      // below: Id, Name, Config, and State members are read to build the response.
      const info = (await this.docker.getContainer(containerId).inspect()) as {
        Id: string;
        Name: string;
        Config?: { Image?: string };
        State?: {
          Status?: string;
          Running?: boolean;
          StartedAt?: string;
          FinishedAt?: string;
          ExitCode?: number;
          OOMKilled?: boolean;
        };
        RestartCount?: number;
      };

      return {
        id: info.Id,
        name: info.Name,
        image: info.Config?.Image ?? '',
        status: info.State?.Status ?? '',
        running: info.State?.Running ?? false,
        restartCount: info.RestartCount ?? 0,
        startedAt: info.State?.StartedAt ?? '',
        finishedAt: info.State?.FinishedAt ?? '',
        exitCode: info.State?.ExitCode ?? 0,
        oomKilled: info.State?.OOMKilled ?? false,
      };
    } catch (error) {
      this.handleDockerError(error, 'container');
    }
  }

  async getHostInfo(): Promise<HostInfo> {
    const toMb = (value: number | null | undefined): number | null => {
      if (!isFiniteInteger(value) || value <= 0) {
        return null;
      }

      return Math.floor(value / 1024 / 1024);
    };

    try {
      // SAFETY: Dockerode info returns the object whose inspected fields are consumed
      // by isDockerInfo below.
      const info = (await this.docker.info()) as DockerInfoInput;
      if (!isDockerInfo(info)) {
        return { totalRamMb: null, cpuCount: null };
      }

      return {
        totalRamMb: toMb(info.MemTotal),
        cpuCount: isFiniteInteger(info.NCPU) && info.NCPU > 0 ? info.NCPU : null,
      };
    } catch (error) {
      this.handleDockerError(error, 'host');
    }
  }

  getHostFreeMemoryMb(): number | null {
    try {
      const bytes = os.freemem();

      if (!isFiniteInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER) {
        return null;
      }

      return Math.floor(bytes / 1024 / 1024);
    } catch {
      return null;
    }
  }

  async getHostDiskInfo(): Promise<DiskInfo> {
    const config = this.readDockerConfig();

    const isValidStatfsField = (value: number | null | undefined): value is number =>
      isFiniteInteger(value) && value >= 0;

    try {
      const stats = await fs.statfs(config.mcDataPath);

      if (
        !isValidStatfsField(stats.bsize) ||
        stats.bsize <= 0 ||
        !isValidStatfsField(stats.blocks) ||
        !isValidStatfsField(stats.bavail) ||
        stats.bavail > stats.blocks
      ) {
        Logger.warn('Invalid statfs output from Docker volume', 'DockerService');

        return { totalDiskMb: null, freeDiskMb: null };
      }

      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;

      if (!Number.isFinite(total) || !Number.isFinite(free)) {
        Logger.warn('Invalid statfs output from Docker volume', 'DockerService');

        return { totalDiskMb: null, freeDiskMb: null };
      }

      return {
        totalDiskMb: Math.floor(total / 1024 / 1024),
        freeDiskMb: Math.floor(free / 1024 / 1024),
      };
    } catch {
      Logger.warn('Failed to read host disk info', 'DockerService');

      return { totalDiskMb: null, freeDiskMb: null };
    }
  }

  private readDockerConfig(): DockerConfig {
    const rawMcDataPath = this.configService.get<string>('MC_DATA_PATH', '/mc-data');
    // compose mounts MC_DATA_PATH_HOST at the fixed /mc-data, so a value that
    // changes under trim() would make statfs measure a different directory
    if (rawMcDataPath !== rawMcDataPath.trim()) {
      throw new BadRequestException('MC_DATA_PATH must not have surrounding whitespace');
    }
    const mcDataPath = rawMcDataPath.trim();
    if (!mcDataPath) throw new BadRequestException('MC_DATA_PATH is not configured');
    if (!path.isAbsolute(mcDataPath)) {
      throw new BadRequestException('MC_DATA_PATH must be an absolute path');
    }
    if (mcDataPath.split(/[\\/]+/).some((seg) => seg === '.' || seg === '..')) {
      throw new BadRequestException('MC_DATA_PATH must not contain . or .. segments');
    }

    // Host-side bind source for Minecraft containers. Defaults to the container
    // path (single-directory deployments); Compose overrides it with
    // MC_DATA_PATH_HOST so a Windows host path is passed verbatim to the daemon
    // (Docker Desktop translates it) instead of failing path.isAbsolute.
    const rawBindSource = this.configService.get<string>('MC_DATA_BIND_SOURCE', mcDataPath);
    if (rawBindSource !== rawBindSource.trim()) {
      throw new BadRequestException('MC_DATA_BIND_SOURCE must not have surrounding whitespace');
    }
    const mcDataBindSource = rawBindSource.trim();
    if (!mcDataBindSource) {
      throw new BadRequestException('MC_DATA_BIND_SOURCE is not configured');
    }
    if (mcDataBindSource.split(/[\\/]+/).some((seg) => seg === '.' || seg === '..')) {
      throw new BadRequestException('MC_DATA_BIND_SOURCE must not contain . or .. segments');
    }

    const network = this.configService.get<string>('DOCKER_NETWORK', 'minepanel_network').trim();
    if (!network) throw new BadRequestException('DOCKER_NETWORK is not configured');
    // host/none/container modes bypass the guarded port mapping — only named networks allowed
    if (network === 'host' || network === 'none' || network.startsWith('container:')) {
      throw new BadRequestException('DOCKER_NETWORK must be a named network');
    }

    const portMin = Number(this.configService.get<number>('MC_PORT_MIN', 25565));
    const portMax = Number(this.configService.get<number>('MC_PORT_MAX', 25665));

    if (
      !Number.isInteger(portMin) ||
      !Number.isInteger(portMax) ||
      portMin < 1 ||
      portMax > 65535 ||
      portMin > portMax
    ) {
      throw new BadRequestException('Invalid MC_PORT_MIN/MC_PORT_MAX configuration');
    }

    return {
      mcDataPath: path.resolve(mcDataPath),
      mcDataBindSource,
      network,
      portMin,
      portMax,
    };
  }

  private validateServerForCreate(
    server: Server,
    config: { portMin: number; portMax: number },
  ): void {
    if (
      !isFiniteInteger(server.port) ||
      server.port < config.portMin ||
      server.port > config.portMax
    ) {
      throw new BadRequestException(
        `Port ${server.port} is outside the allowed range ${config.portMin}-${config.portMax}`,
      );
    }

    if (!Number.isInteger(server.memoryLimitMb) || server.memoryLimitMb < MIN_MEMORY_MB) {
      throw new BadRequestException('Memory limit must be at least 512 MB');
    }

    if (!server.version || server.version.trim() === '') {
      throw new BadRequestException('Server version is required');
    }
  }

  private resolveDataDir(mcDataBindSource: string, serverId: string): string {
    if (!CONTAINER_NAME_PATTERN.test(serverId)) {
      throw new BadRequestException('Invalid server id');
    }

    // Daemon-resolved host path: never normalize with the Linux path module —
    // a Windows bind source must pass through verbatim for Docker Desktop to
    // translate it. Traversal is impossible by construction: the base is
    // segment-validated (no . or ..) and serverId matches [a-z0-9-]+.
    return `${mcDataBindSource.replace(/[\\/]+$/, '')}/${serverId}`;
  }

  private buildEnv(server: Server): string[] {
    const env = [
      'EULA=TRUE',
      'ENABLE_RCON=TRUE',
      `TYPE=${server.provider}`,
      `VERSION=${server.version}`,
      `MEMORY=${server.memoryLimitMb}M`,
    ];

    if (server.maxPlayers) env.push(`MAX_PLAYERS=${server.maxPlayers}`);
    if (server.difficulty) env.push(`DIFFICULTY=${server.difficulty.toLowerCase()}`);
    // itzg uses MODE, not GAMEMODE
    if (server.gamemode) env.push(`MODE=${server.gamemode.toLowerCase()}`);
    if (server.onlineMode !== undefined) {
      env.push(`ONLINE_MODE=${server.onlineMode ? 'TRUE' : 'FALSE'}`);
    }
    if (server.viewDistance) env.push(`VIEW_DISTANCE=${server.viewDistance}`);
    if (server.allowFlight !== undefined) {
      env.push(`ALLOW_FLIGHT=${server.allowFlight ? 'TRUE' : 'FALSE'}`);
    }
    // itzg supports PVP
    if (server.pvp !== undefined) env.push(`PVP=${server.pvp ? 'TRUE' : 'FALSE'}`);
    if (server.motd) env.push(`MOTD=${server.motd.replace(/[\r\n]+/g, ' ')}`);
    // itzg uses SEED, not LEVEL_SEED; worldPath/rconPassword not mapped to env
    if (server.levelSeed) env.push(`SEED=${server.levelSeed.replace(/[\r\n]+/g, ' ')}`);

    return env;
  }

  private isDaemonUnreachable(cause: unknown): boolean {
    if (!isDockerErrorCandidate(cause)) return false;
    if (cause.statusCode !== undefined) return false;

    return cause.code !== undefined && DAEMON_UNREACHABLE_CODES.has(cause.code);
  }

  private isDockerError(cause: unknown): boolean {
    if (cause instanceof HttpException) return true;
    if (!isDockerErrorCandidate(cause)) return false;
    if (cause.statusCode !== undefined) return true;

    return cause.code !== undefined && DAEMON_UNREACHABLE_CODES.has(cause.code);
  }

  private isStatusCode(cause: unknown, statusCode: number): boolean {
    return isDockerErrorCandidate(cause) && cause.statusCode === statusCode;
  }

  private handleDockerError(cause: unknown, context: string): never {
    const statusCode = isDockerErrorCandidate(cause) ? cause.statusCode : undefined;

    if (this.isDaemonUnreachable(cause)) {
      throw new ServiceUnavailableException('Docker daemon unreachable');
    }

    switch (statusCode) {
      case 404:
        throw new NotFoundException(`${context} not found`);
      case 409:
        throw new ConflictException(`${context} conflicts with existing state`);
      case 400:
      case 406:
      case 422:
        throw new BadRequestException(`${context} rejected by Docker`);
      case 502:
      case 503:
      case 504:
        throw new ServiceUnavailableException('Docker daemon unreachable');
      default:
        throw new InternalServerErrorException(`Docker operation failed: ${context}`);
    }
  }
}
