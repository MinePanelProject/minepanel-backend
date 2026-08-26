import crypto from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type User, users } from 'src/db/schema';

export type IdentityProvider = 'google' | 'github';

export type ProviderIdentity = {
  provider: IdentityProvider;
  providerId: string;
  email: string;
  username: string;
};

export type ProviderIdentityResolution =
  | { kind: 'authenticated'; user: User }
  | { kind: 'created'; user: User }
  | { kind: 'linkConfirmationRequired'; user: User };

type IdentityDatabase = Pick<DrizzleDB, 'insert' | 'select' | 'update' | 'transaction'>;

type PostgresErrorRecord = { code?: unknown; cause?: unknown };

// SAFETY: postgres-js attaches the SQLSTATE to the thrown error record's
// cause.code; the type predicate narrows the driver error shape so the 23505
// branch stays exclusive to unique-violation producers at the DB boundary.
const isPostgresErrorRecord = (error: unknown): error is PostgresErrorRecord =>
  typeof error === 'object' && error !== null;

const isUniqueViolation = (error: PostgresErrorRecord): boolean =>
  error.code === '23505' || (isPostgresErrorRecord(error.cause) && error.cause.code === '23505');

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: IdentityDatabase,
    private readonly configService: ConfigService,
  ) {}

  async linkGoogleIdentity(userId: string, providerId: string): Promise<User> {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      throw new Error('Provider identity is required');
    }

    return this.db.transaction(async (tx) => {
      try {
        const [linkedUser] = await tx
          .update(users)
          .set({ googleId: normalizedProviderId })
          .where(and(eq(users.id, userId), isNull(users.googleId)))
          .returning();
        if (linkedUser) {
          return linkedUser;
        }
      } catch (error) {
        if (isPostgresErrorRecord(error) && isUniqueViolation(error)) {
          throw new ConflictException('Google account is already linked');
        }

        throw error;
      }

      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        throw new ConflictException('User not found');
      }

      if (user.googleId === normalizedProviderId) {
        return user;
      }

      throw new ConflictException('Google account is already linked');
    });
  }

  async resolveProviderIdentity(identity: ProviderIdentity): Promise<ProviderIdentityResolution> {
    const providerId = identity.providerId.trim();
    if (!providerId) {
      throw new Error('Provider identity is required');
    }

    const providerIdColumn = identity.provider === 'google' ? users.googleId : users.githubId;
    const [linkedUser] = await this.db
      .select()
      .from(users)
      .where(eq(providerIdColumn, providerId))
      .limit(1);

    if (linkedUser) {
      return { kind: 'authenticated', user: linkedUser };
    }

    const [emailUser] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, identity.email))
      .limit(1);
    if (emailUser) {
      return { kind: 'linkConfirmationRequired', user: emailUser };
    }

    const username = identity.username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      throw new Error('Invalid canonical username');
    }

    const status =
      this.configService.get<string>('REQUIRE_ADMIN_APPROVAL') === 'true' ? 'PENDING' : 'ACTIVE';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate =
        attempt === 0 ? username : `${username.slice(0, 28)}${crypto.randomInt(1000, 10_000)}`;

      try {
        const [createdUser] = await this.db
          .insert(users)
          .values({
            email: identity.email,
            username: candidate,
            passwordHash: null,
            status,
            [identity.provider === 'google' ? 'googleId' : 'githubId']: providerId,
          })
          .returning();

        if (createdUser) {
          return { kind: 'created', user: createdUser };
        }
      } catch (error) {
        if (!isPostgresErrorRecord(error) || !isUniqueViolation(error)) {
          throw error;
        }

        const [concurrentlyLinkedUser] = await this.db
          .select()
          .from(users)
          .where(eq(providerIdColumn, providerId))
          .limit(1);
        if (concurrentlyLinkedUser) {
          return { kind: 'authenticated', user: concurrentlyLinkedUser };
        }

        const [concurrentEmailUser] = await this.db
          .select()
          .from(users)
          .where(eq(users.email, identity.email))
          .limit(1);
        if (concurrentEmailUser) {
          return { kind: 'linkConfirmationRequired', user: concurrentEmailUser };
        }
      }
    }

    throw new ConflictException('Username unavailable');
  }
}
