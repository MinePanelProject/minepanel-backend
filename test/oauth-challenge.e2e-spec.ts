import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { OAuthChallengeService } from 'src/auth/oauth-challenge.service';
import { type DrizzleDB } from 'src/db/db.module';
import * as schema from 'src/db/schema';
import { assertSafeTestDatabase } from './test-database';

const hashChallenge = (challenge: string): string =>
  createHash('sha256').update(challenge).digest('hex');

describe('OAuth challenges (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let service: OAuthChallengeService;
  const challengeIds: string[] = [];

  beforeAll(() => {
    sql = postgres(assertSafeTestDatabase(), { max: 8 });
    db = drizzle(sql, { schema });
    // SAFETY: drizzle(sql, { schema }) is the database producer; the cast
    // satisfies the DrizzleDB contract with the exact live-pg surface the
    // service consumes in this e2e harness.
    service = new OAuthChallengeService(db as DrizzleDB);
  });

  afterAll(async () => {
    if (challengeIds.length > 0) {
      await db
        .delete(schema.oauthChallenges)
        .where(inArray(schema.oauthChallenges.id, challengeIds));
    }
    await sql.end();
  });

  it('allows exactly one concurrent consumer and stores no raw challenge', async () => {
    const challenge = await service.createChallenge('google');
    const challengeHash = hashChallenge(challenge);
    const [stored] = await db
      .select({
        id: schema.oauthChallenges.id,
        challengeHash: schema.oauthChallenges.challengeHash,
      })
      .from(schema.oauthChallenges)
      .where(eq(schema.oauthChallenges.challengeHash, challengeHash));
    challengeIds.push(stored.id);

    expect(stored.challengeHash).toBe(challengeHash);
    expect(stored.challengeHash).not.toBe(challenge);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => service.verifyAndConsume('google', challenge)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    await expect(
      db
        .select({ id: schema.oauthChallenges.id })
        .from(schema.oauthChallenges)
        .where(eq(schema.oauthChallenges.challengeHash, challengeHash)),
    ).resolves.toEqual([]);
  });

  it('rejects expired and provider-mismatched challenges without consuming the valid binding', async () => {
    const expiredChallenge = await service.createChallenge('google');
    const expiredHash = hashChallenge(expiredChallenge);
    const [expiredRow] = await db
      .select({ id: schema.oauthChallenges.id })
      .from(schema.oauthChallenges)
      .where(eq(schema.oauthChallenges.challengeHash, expiredHash));
    challengeIds.push(expiredRow.id);
    await db
      .update(schema.oauthChallenges)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.oauthChallenges.id, expiredRow.id));
    await expect(service.verifyAndConsume('google', expiredChallenge)).resolves.toBe(false);

    const boundChallenge = await service.createChallenge('google');
    const boundHash = hashChallenge(boundChallenge);
    const [boundRow] = await db
      .select({ id: schema.oauthChallenges.id })
      .from(schema.oauthChallenges)
      .where(eq(schema.oauthChallenges.challengeHash, boundHash));
    challengeIds.push(boundRow.id);

    // SAFETY: verifyAndConsume(provider, challenge) is called with the
    // framework-producer string 'github' to prove provider binding; 'never'
    // bypasses the compile-time union only for this negative test input.
    await expect(service.verifyAndConsume('github' as never, boundChallenge)).resolves.toBe(false);
    await expect(service.verifyAndConsume('google', boundChallenge)).resolves.toBe(true);
  });
});
