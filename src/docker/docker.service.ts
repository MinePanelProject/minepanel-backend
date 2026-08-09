import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Dockerode from 'dockerode';
import type { Server } from 'src/db/schema';
import { DOCKERODE, MAX_STOP_TIMEOUT_SECONDS, STOP_TIMEOUT_SECONDS } from './docker.constants';

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

const MINECRAFT_IMAGE = 'itzg/minecraft-server';
const CONTAINER_PORT = '25565/tcp';
const MIN_MEMORY_MB = 512;

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
    const dataDir = this.resolveDataDir(dockerConfig.mcDataPath, server.id);
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
      if (this.isStatusCode(error, 304)) return; // already started, treat as idempotent success
      this.handleDockerError(error, 'container');
    }
  }

  async stopContainer(
    containerId: string,
    stopTimeoutSeconds = STOP_TIMEOUT_SECONDS,
  ): Promise<void> {
    if (
      typeof stopTimeoutSeconds !== 'number' ||
      !Number.isFinite(stopTimeoutSeconds) ||
      !Number.isInteger(stopTimeoutSeconds) ||
      stopTimeoutSeconds < 0 ||
      stopTimeoutSeconds > MAX_STOP_TIMEOUT_SECONDS
    ) {
      throw new BadRequestException('Invalid stop timeout');
    }

    try {
      await this.docker.getContainer(containerId).stop({ t: stopTimeoutSeconds });
    } catch (error) {
      if (this.isStatusCode(error, 304)) return; // already stopped, treat as idempotent success
      this.handleDockerError(error, 'container');
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: false });
    } catch (error) {
      if (this.isStatusCode(error, 404)) return; // already removed, treat as idempotent success
      this.handleDockerError(error, 'container');
    }
  }

  async inspectContainer(containerId: string): Promise<ContainerInspectState> {
    try {
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
    const toMb = (value: unknown): number | null => {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0
      ) {
        return null;
      }

      return Math.floor(value / 1024 / 1024);
    };

    try {
      const info = (await this.docker.info()) as Record<string, unknown> | null | undefined;
      if (typeof info !== 'object' || info === null) {
        return { totalRamMb: null, cpuCount: null };
      }

      return {
        totalRamMb: toMb(info.MemTotal),
        cpuCount:
          typeof info.NCPU === 'number' &&
          Number.isFinite(info.NCPU) &&
          Number.isInteger(info.NCPU) &&
          info.NCPU > 0
            ? info.NCPU
            : null,
      };
    } catch (error) {
      this.handleDockerError(error, 'host');
    }
  }

  async getHostDiskInfo(): Promise<DiskInfo> {
    const config = this.readDockerConfig();

    const isValidStatfsField = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;

    try {
      const stats = await fs.statfs(config.mcDataPath);

      if (
        !isValidStatfsField(stats.bsize) ||
        stats.bsize <= 0 ||
        !isValidStatfsField(stats.blocks) ||
        !isValidStatfsField(stats.bavail) ||
        stats.bavail > stats.blocks
      ) {
        Logger.warn(`Invalid statfs output for ${config.mcDataPath}`, 'DockerService');

        return { totalDiskMb: null, freeDiskMb: null };
      }

      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;

      if (!Number.isFinite(total) || !Number.isFinite(free)) {
        Logger.warn(`Invalid statfs output for ${config.mcDataPath}`, 'DockerService');

        return { totalDiskMb: null, freeDiskMb: null };
      }

      return {
        totalDiskMb: Math.floor(total / 1024 / 1024),
        freeDiskMb: Math.floor(free / 1024 / 1024),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.warn(`Failed to read disk info for ${config.mcDataPath}: ${message}`, 'DockerService');

      return { totalDiskMb: null, freeDiskMb: null };
    }
  }

  private readDockerConfig(): {
    mcDataPath: string;
    network: string;
    portMin: number;
    portMax: number;
  } {
    const rawMcDataPath = this.configService.get<string>('MC_DATA_PATH', '/mc-data');
    // compose mounts MC_DATA_PATH_HOST verbatim, so a value that changes under trim() would
    // make the daemon bind a different directory than statfs measures — reject it
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

    return { mcDataPath: path.resolve(mcDataPath), network, portMin, portMax };
  }

  private validateServerForCreate(
    server: Server,
    config: { portMin: number; portMax: number },
  ): void {
    if (
      typeof server.port !== 'number' ||
      !Number.isFinite(server.port) ||
      !Number.isInteger(server.port) ||
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

  private resolveDataDir(mcDataPath: string, serverId: string): string {
    if (!CONTAINER_NAME_PATTERN.test(serverId)) {
      throw new BadRequestException('Invalid server id');
    }

    const dataRoot = path.resolve(mcDataPath);
    const dataDir = path.resolve(dataRoot, serverId);

    if (path.dirname(dataDir) !== dataRoot || path.basename(dataDir) !== serverId) {
      throw new BadRequestException('Server data path escapes MC_DATA_PATH');
    }

    return dataDir;
  }

  private buildEnv(server: Server): string[] {
    const env = [
      'EULA=TRUE',
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

  private isDaemonUnreachable(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const err = error as { code?: unknown; statusCode?: unknown };
    if (err.statusCode !== undefined) return false; // daemon answered with HTTP status

    return typeof err.code === 'string' && DAEMON_UNREACHABLE_CODES.has(err.code);
  }

  private isStatusCode(error: unknown, statusCode: number): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { statusCode?: unknown }).statusCode === statusCode
    );
  }

  private handleDockerError(error: unknown, context: string): never {
    const statusCode =
      typeof error === 'object' && error !== null
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;

    if (this.isDaemonUnreachable(error)) {
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
