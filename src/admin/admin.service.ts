import crypto from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { and, asc, count, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import {
  modPermissions,
  type Role,
  refreshTokens,
  servers,
  type UserStatus,
  users,
} from 'src/db/schema';
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { type GrantModPermissionDto } from './dto/grant-mod-permission.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

type AdminTransaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

// Advisory lock key serializing every role/status transition so the
// "at least one active admin" invariant can never be raced away.
const LAST_ADMIN_LOCK_KEY = 7331;
const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async listUsers(query: ListUsersQueryDto): Promise<PublicUser[]> {
    const filters: SQL[] = [];
    if (query.status) {
      filters.push(eq(users.status, query.status));
    }
    if (query.role) {
      filters.push(eq(users.role, query.role));
    }

    const rows = await this.db
      .select()
      .from(users)
      .where(and(...filters))
      .orderBy(users.createdAt);

    return rows.map(toPublicUser);
  }

  async updateStatus(userId: string, status: UserStatus): Promise<PublicUser> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK_KEY})`);

      const [target] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) {
        throw new NotFoundException('User not found');
      }
      if (target.status === status) {
        throw new BadRequestException('No changes');
      }
      if (this.deactivates(target.role, target.status, status)) {
        await this.assertActiveAdminsRemain(tx);
      }

      const [updated] = await tx
        .update(users)
        .set({ status })
        .where(eq(users.id, userId))
        .returning();

      if (status === 'BANNED') {
        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      }

      return toPublicUser(updated);
    });
  }

  async updateRole(userId: string, role: Role): Promise<PublicUser> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK_KEY})`);

      const [target] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) {
        throw new NotFoundException('User not found');
      }
      if (target.role === role) {
        throw new BadRequestException('No changes');
      }
      if (this.demotes(target.role, target.status, role)) {
        await this.assertActiveAdminsRemain(tx);
      }

      const [updated] = await tx
        .update(users)
        .set({ role })
        .where(eq(users.id, userId))
        .returning();

      await tx.delete(modPermissions).where(eq(modPermissions.userId, userId));

      return toPublicUser(updated);
    });
  }

  async listModPermissions(userId: string): Promise<(typeof modPermissions.$inferSelect)[]> {
    const [target] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    return this.db
      .select()
      .from(modPermissions)
      .where(eq(modPermissions.userId, userId))
      .orderBy(asc(modPermissions.createdAt), asc(modPermissions.id));
  }

  async grantModPermission(
    userId: string,
    dto: GrantModPermissionDto,
  ): Promise<typeof modPermissions.$inferSelect> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK_KEY})`);

      const [target] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) {
        throw new NotFoundException('User not found');
      }
      if (target.role !== 'MOD') {
        throw new BadRequestException('User is not a MOD');
      }

      const rawServerId = dto.serverId ?? null;
      if (rawServerId !== null && rawServerId.trim() === '') {
        throw new BadRequestException('serverId must not be blank');
      }
      const serverId = rawServerId === null ? null : rawServerId.trim();
      if (serverId) {
        const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).limit(1);
        if (!server) {
          throw new NotFoundException('Server not found');
        }
      }

      const [inserted] = await tx
        .insert(modPermissions)
        .values({ userId, permission: dto.permission, serverId })
        .onConflictDoNothing()
        .returning();

      if (inserted) return inserted;

      const [existing] = await tx
        .select()
        .from(modPermissions)
        .where(
          and(
            eq(modPermissions.userId, userId),
            eq(modPermissions.permission, dto.permission),
            serverId === null
              ? isNull(modPermissions.serverId)
              : eq(modPermissions.serverId, serverId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new ConflictException('Permission grant already exists');
      }

      throw new ConflictException('Permission grant already exists');
    });
  }

  async revokeModPermission(userId: string, permId: string): Promise<void> {
    const [target] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    const result = await this.db
      .delete(modPermissions)
      .where(and(eq(modPermissions.id, permId), eq(modPermissions.userId, userId)))
      .returning({ id: modPermissions.id });

    if (result.length === 0) {
      throw new NotFoundException('Permission grant not found');
    }
  }

  async resetPassword(userId: string): Promise<{ tempPassword: string }> {
    const [target] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    const tempPassword = crypto.randomBytes(12).toString('base64url');
    const tempPasswordHash = await bcrypt.hash(tempPassword, 10);
    const tempPasswordExpiresAt = new Date(Date.now() + TEMP_PASSWORD_TTL_MS);

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tempPasswordHash, tempPasswordExpiresAt, mustChangePassword: true })
        .where(eq(users.id, userId));
      // revoke every active refresh session so the new credential is the only way in
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    });

    return { tempPassword };
  }

  async removeTwoFactor(userId: string): Promise<PublicUser> {
    const [target] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (!target.totpEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    // single atomic update clears secret, enabled flag and backup codes together
    const [updated] = await this.db
      .update(users)
      .set({ totpEnabled: false, totpSecret: null, totpBackupCodes: null })
      .where(eq(users.id, userId))
      .returning();

    return toPublicUser(updated);
  }

  private async assertActiveAdminsRemain(tx: AdminTransaction): Promise<void> {
    const [row] = await tx
      .select({ activeAdmins: count() })
      .from(users)
      .where(and(eq(users.role, 'ADMIN'), eq(users.status, 'ACTIVE')));

    if ((row?.activeAdmins ?? 0) <= 1) {
      throw new ConflictException('Cannot deactivate the last active admin');
    }
  }

  private deactivates(targetRole: Role, targetStatus: UserStatus, nextStatus: UserStatus): boolean {
    return targetRole === 'ADMIN' && targetStatus === 'ACTIVE' && nextStatus !== 'ACTIVE';
  }

  private demotes(targetRole: Role, targetStatus: UserStatus, nextRole: Role): boolean {
    return targetRole === 'ADMIN' && targetStatus === 'ACTIVE' && nextRole !== 'ADMIN';
  }
}
