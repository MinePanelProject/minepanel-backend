import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, eq, exists, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { deferred } from 'src/common/deferred';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import {
  type NewServer,
  type Server,
  type ServerStatus,
  serverAccess,
  servers,
} from 'src/db/schema';
import { DockerService } from 'src/docker/docker.service';
import { CreateServerDto } from './dto/create-server.dto';
import { ListServersQueryDto } from './dto/list-servers-query.dto';
import { type PublicServer, toPublicServer } from './public-server';
import { type ServerPrincipal } from './server-access';

type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

// Serializes memory admission and create/start/restart claims across the
// backend. Distinct from AdminService's LAST_ADMIN_LOCK_KEY (7331).
const LIFECYCLE_LOCK_KEY = 7332;
const DEFAULT_MIN_FREE_DISK_MB = 2048;
const DEFAULT_MAX_MEMORY_RATIO = 0.9;

type ResourceConfig = {
  minFreeDiskMb: number;
  maxMemoryRatio: number;
};

type ReconciliationOutcome =
  | { kind: 'state'; status: ServerStatus; containerId: string | null }
  | { kind: 'unavailable' }
  | { kind: 'unchanged' };

type LifecycleUpdateSet = Partial<Omit<Server, 'updatedAt'>> & { updatedAt: SQL<unknown> };

@Injectable()
export class ServersService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dockerService: DockerService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.db.select().from(servers).where(ne(servers.status, 'STOPPED'));

    const outcomes = await Promise.all(
      rows.map(async (row) => ({ row, outcome: await this.reconcileRow(row) })),
    );

    if (outcomes.some(({ outcome }) => outcome.kind === 'unavailable')) {
      Logger.warn(
        'Docker daemon unreachable during startup reconciliation; lifecycle rows left untouched',
        'ServersService',
      );
      return;
    }

    await Promise.all(
      outcomes.map(async ({ row, outcome }) => {
        if (outcome.kind !== 'state') return;
        if (row.status === outcome.status && row.containerId === outcome.containerId) return;

        const set: LifecycleUpdateSet = {
          status: outcome.status,
          containerId: outcome.containerId,
          updatedAt: sql`now()`,
        };

        await this.db
          .update(servers)
          .set(set)
          .where(
            and(
              eq(servers.id, row.id),
              eq(servers.status, row.status),
              row.containerId
                ? eq(servers.containerId, row.containerId)
                : isNull(servers.containerId),
              // now() stores microseconds; postgres-js reads millisecond Dates —
              // compare epoch milliseconds so the snapshot check is exact.
              sql`floor(extract(epoch from ${servers.updatedAt}) * 1000)::bigint = ${row.updatedAt.getTime()}`,
            ),
          );
      }),
    );
  }

  private async reconcileRow(row: Server): Promise<ReconciliationOutcome> {
    let inspectError: Error | null = null;

    if (row.containerId) {
      try {
        const state = await this.dockerService.inspectContainer(row.containerId);
        return {
          kind: 'state',
          status: state.running ? 'RUNNING' : 'STOPPED',
          containerId: state.id,
        };
      } catch (error) {
        if (error instanceof ServiceUnavailableException) {
          return { kind: 'unavailable' };
        }
        inspectError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (inspectError && !(inspectError instanceof NotFoundException)) {
      Logger.warn(
        'Startup reconciliation skipped a row due to an unexpected error',
        'ServersService',
      );
      return { kind: 'unchanged' };
    }

    const lookup = await this.dockerService.findManagedContainer(row.id);

    if (lookup && 'unavailable' in lookup) {
      return { kind: 'unavailable' };
    }

    if (lookup) {
      return {
        kind: 'state',
        status: lookup.running ? 'RUNNING' : 'STOPPED',
        containerId: lookup.id,
      };
    }

    return { kind: 'state', status: 'STOPPED', containerId: null };
  }

  async createServer(dto: CreateServerDto, principal: ServerPrincipal): Promise<PublicServer> {
    const config = this.parseResourceConfig();
    const hostInfo = await this.dockerService.getHostInfo();
    const diskInfo = await this.dockerService.getHostDiskInfo();

    this.checkDisk(diskInfo, config.minFreeDiskMb, 'Insufficient disk space to create server');

    const created = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIFECYCLE_LOCK_KEY})`);

      const currentAllocationMb = await this.getCurrentAllocationMb(tx);
      const requestedMb = dto.memoryLimitMb ?? 2048;

      this.checkMemoryAdmission(
        hostInfo,
        config.maxMemoryRatio,
        requestedMb,
        currentAllocationMb,
        'Insufficient memory to create server',
      );

      const newServer: NewServer = {
        name: dto.name,
        provider: dto.provider,
        version: dto.version,
        port: dto.port,
        status: 'CREATING',
        maxPlayers: dto.maxPlayers ?? 20,
        difficulty: dto.difficulty ?? 'NORMAL',
        gamemode: dto.gamemode ?? 'SURVIVAL',
        pvp: dto.pvp ?? true,
        memoryLimitMb: requestedMb,
        motd: dto.motd ?? null,
        levelSeed: dto.levelSeed ?? null,
        onlineMode: dto.onlineMode ?? true,
        viewDistance: dto.viewDistance ?? 10,
        allowFlight: dto.allowFlight ?? false,
        ownerId: principal.id,
        accessType: dto.accessType ?? 'OPEN',
      };

      const [row] = await tx.insert(servers).values(newServer).returning();
      return row;
    });

    let containerId: string;

    try {
      containerId = await this.dockerService.createContainer(created);
    } catch (error) {
      await this.compensateCreateFailure(created.id);
      throw error;
    }

    const persisted = await this.claimContainerId(created.id, containerId);

    if (!persisted) {
      // The container exists but the claim lost its CAS: recover it via the
      // managed lookup instead of leaving a container untracked.
      await this.compensateCreateFailure(created.id);
      throw new InternalServerErrorException('Failed to persist container id');
    }

    try {
      await this.dockerService.startContainer(containerId);
    } catch (error) {
      await this.transition(created.id, 'CREATING', 'ERROR', containerId, undefined);
      throw error;
    }

    const running = await this.transition(
      created.id,
      'CREATING',
      'RUNNING',
      containerId,
      undefined,
    );

    if (!running) {
      throw new InternalServerErrorException('Failed to finalize running server state');
    }

    return toPublicServer(running);
  }

  async listServers(
    query: ListServersQueryDto,
    principal: ServerPrincipal,
  ): Promise<{ data: PublicServer[]; total: number }> {
    const where = this.buildVisibilityPredicate(principal);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(servers)
        .where(where)
        .orderBy(asc(servers.createdAt), asc(servers.id))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(servers).where(where),
    ]);

    return {
      data: rows.map(toPublicServer),
      total: Number(total),
    };
  }

  async getServer(id: string, principal: ServerPrincipal): Promise<PublicServer> {
    const row = await this.loadVisibleServer(id, principal);
    return toPublicServer(row);
  }

  async startServer(id: string, principal: ServerPrincipal): Promise<PublicServer> {
    const row = await this.loadVisibleServer(id, principal);

    if (row.status !== 'STOPPED') {
      throw new ConflictException('Server is not in STOPPED state');
    }

    const containerId = row.containerId;

    if (!containerId) {
      throw new ConflictException('Server container is not provisioned');
    }

    const config = this.parseResourceConfig();
    const hostInfo = await this.dockerService.getHostInfo();
    const diskInfo = await this.dockerService.getHostDiskInfo();

    this.checkDisk(diskInfo, config.minFreeDiskMb, 'Insufficient disk space to start server');

    const started = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIFECYCLE_LOCK_KEY})`);

      const currentAllocationMb = await this.getCurrentAllocationMb(tx, {
        excludeServerId: id,
        includeStopped: false,
      });
      this.checkMemoryAdmission(
        hostInfo,
        config.maxMemoryRatio,
        row.memoryLimitMb,
        currentAllocationMb,
        'Insufficient memory to start server',
      );

      return this.transitionInTx(tx, id, 'STOPPED', 'STARTING', containerId, undefined);
    });

    if (!started) {
      throw new ConflictException('Server is not in STOPPED state');
    }

    try {
      await this.dockerService.startContainer(containerId);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        await this.transition(id, 'STARTING', 'ERROR', containerId, undefined);
      } else {
        await this.transition(id, 'STARTING', 'STOPPED', containerId, undefined);
      }
      throw error;
    }

    const running = await this.transition(id, 'STARTING', 'RUNNING', containerId, undefined);

    if (!running) {
      await this.transition(id, 'STARTING', 'ERROR', containerId, undefined);
      throw new InternalServerErrorException('Failed to finalize running server state');
    }

    return toPublicServer(running);
  }

  async stopServer(id: string, principal: ServerPrincipal): Promise<PublicServer> {
    const row = await this.loadVisibleServer(id, principal);

    if (row.status !== 'RUNNING') {
      throw new ConflictException('Server is not in RUNNING state');
    }

    const containerId = row.containerId;

    if (!containerId) {
      throw new InternalServerErrorException('Running server has no container id');
    }

    const warnSeconds = this.parseStopWarnSeconds();

    const stopping = await this.transition(id, 'RUNNING', 'STOPPING', containerId, undefined);

    if (!stopping) {
      throw new ConflictException('Server is not in RUNNING state');
    }

    try {
      await this.gracefulStopContainer(containerId, warnSeconds);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        await this.transition(id, 'STOPPING', 'ERROR', containerId, undefined);
      } else if (error instanceof NotFoundException) {
        // The container no longer exists (removed externally): the truthful
        // state is stopped, not running.
        await this.transition(id, 'STOPPING', 'STOPPED', containerId, undefined);
      } else {
        // Known failure: the daemon answered and rejected the stop, so the
        // container is still running — restore the truthful prior state.
        await this.transition(id, 'STOPPING', 'RUNNING', containerId, undefined);
      }
      throw error;
    }

    const stopped = await this.transition(id, 'STOPPING', 'STOPPED', containerId, undefined);

    if (!stopped) {
      throw new InternalServerErrorException('Failed to finalize stopped server state');
    }

    return toPublicServer(stopped);
  }

  async restartServer(id: string, principal: ServerPrincipal): Promise<PublicServer> {
    const row = await this.loadVisibleServer(id, principal);

    if (row.status !== 'RUNNING') {
      throw new ConflictException('Server is not in RUNNING state');
    }

    const containerId = row.containerId;

    if (!containerId) {
      throw new InternalServerErrorException('Running server has no container id');
    }

    const warnSeconds = this.parseStopWarnSeconds();

    const stopping = await this.transition(id, 'RUNNING', 'STOPPING', containerId, undefined);

    if (!stopping) {
      throw new ConflictException('Server is not in RUNNING state');
    }

    try {
      await this.gracefulStopContainer(containerId, warnSeconds);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        await this.transition(id, 'STOPPING', 'ERROR', containerId, undefined);
      } else if (error instanceof NotFoundException) {
        // Container removed externally: nothing to stop — truthful STOPPED.
        await this.transition(id, 'STOPPING', 'STOPPED', containerId, undefined);
      } else {
        // Known failure: the daemon rejected the stop, container still running.
        await this.transition(id, 'STOPPING', 'RUNNING', containerId, undefined);
      }
      throw error;
    }

    try {
      const config = this.parseResourceConfig();
      const hostInfo = await this.dockerService.getHostInfo();
      const diskInfo = await this.dockerService.getHostDiskInfo();

      this.checkDisk(diskInfo, config.minFreeDiskMb, 'Insufficient disk space to restart server');

      const starting = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIFECYCLE_LOCK_KEY})`);

        const currentAllocationMb = await this.getCurrentAllocationMb(tx, {
          excludeServerId: id,
          includeStopped: false,
        });
        this.checkMemoryAdmission(
          hostInfo,
          config.maxMemoryRatio,
          row.memoryLimitMb,
          currentAllocationMb,
          'Insufficient memory to restart server',
        );

        return this.transitionInTx(tx, id, 'STOPPING', 'STARTING', containerId, undefined);
      });

      if (!starting) {
        throw new ConflictException('Server is not in STOPPED state');
      }

      try {
        await this.dockerService.startContainer(containerId);
      } catch (error) {
        if (error instanceof ServiceUnavailableException) {
          // Ambiguous outcome: the start may have been accepted — never claim a
          // false terminal STOPPED; ERROR is reconciled on the next boot.
          await this.transition(id, 'STARTING', 'ERROR', containerId, undefined);
        } else {
          // Known failure: the daemon answered and rejected the start, so the
          // container is confirmed stopped.
          await this.transition(id, 'STARTING', 'STOPPED', containerId, undefined);
        }
        throw error;
      }

      const running = await this.transition(id, 'STARTING', 'RUNNING', containerId, undefined);

      if (!running) {
        await this.transition(id, 'STARTING', 'ERROR', containerId, undefined);
        throw new InternalServerErrorException('Failed to finalize running server state');
      }

      return toPublicServer(running);
    } catch (error) {
      // Admission/pre-claim failures leave the row in STOPPING with the
      // container confirmed stopped by the stop phase — settle truthfully.
      await this.transition(id, 'STOPPING', 'STOPPED', containerId, undefined);
      throw error;
    }
  }

  async deleteServer(id: string, principal: ServerPrincipal): Promise<void> {
    const row = await this.loadVisibleServer(id, principal);

    if (row.status !== 'STOPPED') {
      throw new ConflictException('Server is not in STOPPED state');
    }

    const deleting = await this.transition(id, 'STOPPED', 'STOPPING', row.containerId, undefined);

    if (!deleting) {
      throw new ConflictException('Server is not in STOPPED state');
    }

    if (deleting.containerId) {
      try {
        await this.dockerService.removeContainer(deleting.containerId);
      } catch (error) {
        const removed = await this.resolveDeleteRemoveFailure(id, deleting.containerId);
        if (!removed) throw error;
      }
    }

    await this.db.delete(servers).where(and(eq(servers.id, id), eq(servers.status, 'STOPPING')));
  }

  private parseStopWarnSeconds(): number {
    const raw = String(this.configService.get<string>('STOP_WARN_SECONDS', '30'));

    if (!/^\d+$/.test(raw)) {
      throw new ServiceUnavailableException('Graceful shutdown configuration unavailable');
    }

    const value = Number(raw);

    if (!Number.isSafeInteger(value) || value > 300) {
      throw new ServiceUnavailableException('Graceful shutdown configuration unavailable');
    }

    return value;
  }

  private async gracefulStopContainer(containerId: string, warnSeconds: number): Promise<void> {
    let rconFailed = false;

    try {
      await this.dockerService.executeRconCommand(containerId, [
        'say',
        `§cServer closing in ${warnSeconds} seconds...`,
      ]);

      if (warnSeconds > 0) {
        await this.sleep(warnSeconds * 1000);
      }

      await this.dockerService.executeRconCommand(containerId, ['save-all']);
      await this.sleep(3000);
    } catch {
      // Any RCON-phase failure (unavailable CLI, transport, HTTP status, or
      // timeout) leaves the container state uncertain — degrade to the direct
      // Docker stop; only its result classifies the transition.
      rconFailed = true;
    }

    await this.dockerService.stopContainer(containerId, rconFailed ? 10 : 15);
  }

  private async sleep(ms: number): Promise<void> {
    const { promise, resolve } = deferred<void>();
    setTimeout(resolve, ms);
    return promise;
  }

  private async resolveDeleteRemoveFailure(id: string, containerId: string): Promise<boolean> {
    try {
      const state = await this.dockerService.inspectContainer(containerId);

      if (state.running) {
        await this.transition(id, 'STOPPING', 'ERROR', containerId, undefined);
        return false;
      }

      await this.db.delete(servers).where(and(eq(servers.id, id), eq(servers.status, 'STOPPING')));
      return true;
    } catch (inspectError) {
      if (inspectError instanceof NotFoundException) {
        await this.db
          .delete(servers)
          .where(and(eq(servers.id, id), eq(servers.status, 'STOPPING')));
        return true;
      }

      await this.transition(id, 'STOPPING', 'ERROR', containerId, undefined);
      return false;
    }
  }

  private async compensateCreateFailure(serverId: string): Promise<void> {
    const lookup = await this.dockerService.findManagedContainer(serverId);

    if (lookup && 'unavailable' in lookup) {
      return;
    }

    if (lookup) {
      await this.db
        .update(servers)
        .set({
          containerId: lookup.id,
          status: 'ERROR',
          updatedAt: sql`now()`,
        })
        .where(and(eq(servers.id, serverId), eq(servers.status, 'CREATING')));
      return;
    }

    await this.db
      .delete(servers)
      .where(and(eq(servers.id, serverId), eq(servers.status, 'CREATING')));
  }

  private async claimContainerId(serverId: string, containerId: string): Promise<Server | null> {
    const [row] = await this.db
      .update(servers)
      .set({
        containerId,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(servers.id, serverId), eq(servers.status, 'CREATING'), isNull(servers.containerId)),
      )
      .returning();

    return row ?? null;
  }

  private async transition(
    id: string,
    expectedStatus: ServerStatus,
    nextStatus: ServerStatus,
    expectedContainerId: string | null,
    newContainerId: string | null | undefined,
  ): Promise<Server | null> {
    return this.db.transaction(async (tx) => {
      return this.transitionInTx(
        tx,
        id,
        expectedStatus,
        nextStatus,
        expectedContainerId,
        newContainerId,
      );
    });
  }

  private async transitionInTx(
    tx: Tx,
    id: string,
    expectedStatus: ServerStatus,
    nextStatus: ServerStatus,
    expectedContainerId: string | null,
    newContainerId: string | null | undefined,
  ): Promise<Server | null> {
    const set: LifecycleUpdateSet = {
      status: nextStatus,
      updatedAt: sql`now()`,
    };

    if (newContainerId !== undefined) {
      set.containerId = newContainerId;
    }

    const [row] = await tx
      .update(servers)
      .set(set)
      .where(
        and(
          eq(servers.id, id),
          eq(servers.status, expectedStatus),
          expectedContainerId
            ? eq(servers.containerId, expectedContainerId)
            : isNull(servers.containerId),
        ),
      )
      .returning();

    return row ?? null;
  }

  private async loadVisibleServer(id: string, principal: ServerPrincipal): Promise<Server> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), this.buildVisibilityPredicate(principal)))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Server not found');
    }

    return row;
  }

  private buildVisibilityPredicate(principal: ServerPrincipal): SQL {
    const notCreating = ne(servers.status, 'CREATING');

    if (principal.role === 'ADMIN') {
      return notCreating;
    }

    const approvedAccess = this.db
      .select()
      .from(serverAccess)
      .where(
        and(
          eq(serverAccess.userId, principal.id),
          eq(serverAccess.serverId, servers.id),
          eq(serverAccess.status, 'APPROVED'),
        ),
      );

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    return and(notCreating, or(eq(servers.accessType, 'OPEN'), exists(approvedAccess))) as SQL;
  }

  private async getCurrentAllocationMb(
    tx: Tx,
    options: { excludeServerId?: string; includeStopped?: boolean } = { includeStopped: true },
  ): Promise<number> {
    const rows = options.includeStopped
      ? await tx.select({ id: servers.id, memoryLimitMb: servers.memoryLimitMb }).from(servers)
      : await tx
          .select({ id: servers.id, memoryLimitMb: servers.memoryLimitMb })
          .from(servers)
          .where(ne(servers.status, 'STOPPED'));

    return rows.reduce(
      (sum, row) => (row.id !== options.excludeServerId ? sum + (row.memoryLimitMb ?? 0) : sum),
      0,
    );
  }

  private parseResourceConfig(): ResourceConfig {
    const rawMinFreeDisk = this.configService.get<string>(
      'MIN_FREE_DISK_MB',
      String(DEFAULT_MIN_FREE_DISK_MB),
    );
    const rawRatio = this.configService.get<string>(
      'MAX_MEMORY_RATIO',
      String(DEFAULT_MAX_MEMORY_RATIO),
    );

    const minFreeDiskMb = Number(rawMinFreeDisk);
    const maxMemoryRatio = Number(rawRatio);

    if (
      !Number.isSafeInteger(minFreeDiskMb) ||
      minFreeDiskMb <= 0 ||
      !Number.isFinite(maxMemoryRatio) ||
      maxMemoryRatio <= 0 ||
      maxMemoryRatio > 1
    ) {
      throw new ServiceUnavailableException('Host resource information unavailable');
    }

    return { minFreeDiskMb, maxMemoryRatio };
  }

  private checkDisk(
    diskInfo: { totalDiskMb: number | null; freeDiskMb: number | null },
    minFreeDiskMb: number,
    message: string,
  ): void {
    if (diskInfo.totalDiskMb === null || diskInfo.freeDiskMb === null) {
      throw new ServiceUnavailableException('Host resource information unavailable');
    }

    if (diskInfo.freeDiskMb < minFreeDiskMb) {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'InsufficientResources',
          message,
          details: {
            resource: 'disk',
            availableMb: diskInfo.freeDiskMb,
            requiredMb: minFreeDiskMb,
            totalMb: diskInfo.totalDiskMb,
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private checkMemoryAdmission(
    hostInfo: { totalRamMb: number | null; cpuCount: number | null },
    maxMemoryRatio: number,
    requestedMb: number,
    currentAllocationMb: number,
    message: string,
  ): void {
    if (hostInfo.totalRamMb === null || hostInfo.cpuCount === null) {
      throw new ServiceUnavailableException('Host resource information unavailable');
    }

    const allocatableMb = Math.floor(hostInfo.totalRamMb * maxMemoryRatio);
    const availableMb = Math.max(allocatableMb - currentAllocationMb, 0);

    if (requestedMb > availableMb) {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'InsufficientResources',
          message,
          details: {
            resource: 'memory',
            availableMb,
            requiredMb: requestedMb,
            totalMb: hostInfo.totalRamMb,
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }
}
