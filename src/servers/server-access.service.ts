import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type AccessType, serverAccess, servers, type User, users } from 'src/db/schema';
import {
  type AccessRequestProjection,
  type MyAccessRequestProjection,
  type ServerPrincipal,
  toMyAccessRequest,
} from './server-access';

const MAX_RACE_RETRIES = 1;
type ServerAccessDatabase = Pick<DrizzleDB, 'select' | 'insert' | 'update' | 'delete'>;

@Injectable()
export class ServerAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: ServerAccessDatabase) {}

  async requestAccess(
    serverId: string,
    principal: ServerPrincipal,
  ): Promise<MyAccessRequestProjection> {
    if (principal.role === 'ADMIN') {
      throw new ConflictException('Admins already have access to all servers');
    }

    const server = await this.loadRequestableServer(serverId);

    if (server.accessType === 'OPEN') {
      throw new ConflictException('Server access is already open');
    }

    if (server.accessType === 'PRIVATE') {
      throw new NotFoundException('Server not found');
    }

    const row = await this.upsertPendingWithRetry(serverId, principal.id);
    return toMyAccessRequest(row);
  }

  async getMyAccessRequest(
    serverId: string,
    principal: ServerPrincipal,
  ): Promise<MyAccessRequestProjection> {
    const server = await this.loadRequestableServer(serverId);

    if (server.accessType === 'OPEN') {
      throw new NotFoundException('Access request not found');
    }

    if (server.accessType === 'PRIVATE') {
      throw new NotFoundException('Server not found');
    }

    const row = await this.findAccess(serverId, principal.id);
    if (!row) {
      throw new NotFoundException('Access request not found');
    }

    return toMyAccessRequest(row);
  }

  async listAccessRequests(serverId: string): Promise<AccessRequestProjection[]> {
    const server = await this.loadServerForAdmin(serverId);

    if (server.accessType !== 'REQUEST') {
      throw new ConflictException('Server does not use request-based access');
    }

    const rows = await this.db
      .select({
        userId: users.id,
        username: users.username,
        email: users.email,
        status: serverAccess.status,
        requestedAt: serverAccess.createdAt,
        approvedAt: serverAccess.approvedAt,
      })
      .from(serverAccess)
      .innerJoin(users, eq(users.id, serverAccess.userId))
      .where(and(eq(serverAccess.serverId, serverId), eq(serverAccess.status, 'PENDING')))
      .orderBy(asc(serverAccess.createdAt), asc(serverAccess.id));

    return rows.map((row) => ({
      userId: row.userId,
      username: row.username,
      email: row.email,
      status: row.status,
      requestedAt: row.requestedAt,
      approvedAt: row.approvedAt ?? null,
    }));
  }

  async approveAccess(serverId: string, targetUserId: string): Promise<AccessRequestProjection> {
    const server = await this.loadServerForAdmin(serverId);
    const targetUser = await this.loadTargetUser(targetUserId);

    if (targetUser.role === 'ADMIN') {
      throw new BadRequestException('Cannot assign access to an admin');
    }

    if (server.accessType === 'OPEN') {
      throw new ConflictException('Server access is already open');
    }

    const row = await this.approveWithRetry(server.accessType, serverId, targetUserId);

    return {
      userId: targetUser.id,
      username: targetUser.username,
      email: targetUser.email,
      status: row.status,
      requestedAt: row.createdAt,
      approvedAt: row.approvedAt ?? null,
    };
  }

  async revokeAccess(serverId: string, targetUserId: string): Promise<void> {
    await this.loadServerForAdmin(serverId);

    const result = await this.db
      .delete(serverAccess)
      .where(and(eq(serverAccess.serverId, serverId), eq(serverAccess.userId, targetUserId)))
      .returning({ id: serverAccess.id });

    if (result.length === 0) {
      throw new NotFoundException('Access request not found');
    }
  }

  private async upsertPendingWithRetry(
    serverId: string,
    userId: string,
    attempt = 0,
  ): Promise<typeof serverAccess.$inferSelect> {
    const inserted = await this.tryInsertPending(serverId, userId);
    if (inserted) return inserted;

    const existing = await this.findAccess(serverId, userId);
    if (existing) {
      if (existing.status === 'PENDING') {
        throw new ConflictException('Access request already pending');
      }

      throw new ConflictException('Server access already approved');
    }

    if (attempt >= MAX_RACE_RETRIES) {
      // the access row vanished concurrently (revoke/delete); report the actual
      // outcome: a live REQUEST server with an absent row is a retryable race,
      // a missing/non-REQUEST server is the documented 404
      const server = await this.loadRequestableServer(serverId).catch(() => null);
      if (!server || server.accessType !== 'REQUEST') {
        throw new NotFoundException('Server not found');
      }

      throw new ConflictException('Access request state changed, please retry');
    }

    const server = await this.loadRequestableServer(serverId);
    if (server.accessType !== 'REQUEST') {
      throw new NotFoundException('Server not found');
    }

    return this.upsertPendingWithRetry(serverId, userId, attempt + 1);
  }

  private async approveWithRetry(
    serverAccessType: AccessType,
    serverId: string,
    userId: string,
    attempt = 0,
  ): Promise<typeof serverAccess.$inferSelect> {
    const approved = await this.tryApprovePending(serverId, userId);
    if (approved) return approved;

    const existing = await this.findAccess(serverId, userId);
    if (existing) {
      if (existing.status === 'APPROVED') {
        throw new ConflictException('Server access already approved');
      }

      if (attempt >= MAX_RACE_RETRIES) {
        // the observed row is still PENDING — never claim APPROVED without an
        // approved row
        throw new ConflictException('Access request still pending');
      }

      return this.approveWithRetry(serverAccessType, serverId, userId, attempt + 1);
    }

    if (serverAccessType === 'REQUEST') {
      throw new NotFoundException('Access request not found');
    }

    const inserted = await this.tryInsertApproved(serverId, userId);
    if (inserted) return inserted;

    if (attempt >= MAX_RACE_RETRIES) {
      // re-read: report only the actually-observed state, never a fabricated one
      const existing = await this.findAccess(serverId, userId);
      if (existing?.status === 'APPROVED') {
        throw new ConflictException('Server access already approved');
      }
      if (existing?.status === 'PENDING') {
        throw new ConflictException('Access request still pending');
      }

      throw new NotFoundException('Access request not found');
    }

    return this.approveWithRetry(serverAccessType, serverId, userId, attempt + 1);
  }

  private async tryInsertPending(
    serverId: string,
    userId: string,
  ): Promise<typeof serverAccess.$inferSelect | null> {
    const [row] = await this.db
      .insert(serverAccess)
      .values({ serverId, userId, status: 'PENDING' })
      .onConflictDoNothing()
      .returning();

    return row ?? null;
  }

  private async tryInsertApproved(
    serverId: string,
    userId: string,
  ): Promise<typeof serverAccess.$inferSelect | null> {
    const [row] = await this.db
      .insert(serverAccess)
      .values({ serverId, userId, status: 'APPROVED', approvedAt: sql`now()` })
      .onConflictDoNothing()
      .returning();

    return row ?? null;
  }

  private async tryApprovePending(
    serverId: string,
    userId: string,
  ): Promise<typeof serverAccess.$inferSelect | null> {
    const [row] = await this.db
      .update(serverAccess)
      .set({ status: 'APPROVED', approvedAt: sql`now()` })
      .where(
        and(
          eq(serverAccess.serverId, serverId),
          eq(serverAccess.userId, userId),
          eq(serverAccess.status, 'PENDING'),
        ),
      )
      .returning();

    return row ?? null;
  }

  private async findAccess(
    serverId: string,
    userId: string,
  ): Promise<typeof serverAccess.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(serverAccess)
      .where(and(eq(serverAccess.serverId, serverId), eq(serverAccess.userId, userId)))
      .limit(1);

    return row ?? null;
  }

  private async loadRequestableServer(serverId: string): Promise<typeof servers.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), ne(servers.status, 'CREATING')))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Server not found');
    }

    return row;
  }

  private async loadServerForAdmin(serverId: string): Promise<typeof servers.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), ne(servers.status, 'CREATING')))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Server not found');
    }

    return row;
  }

  private async loadTargetUser(userId: string): Promise<User> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (!row) {
      throw new NotFoundException('User not found');
    }

    return row;
  }
}
