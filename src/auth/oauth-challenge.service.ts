import crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { oauthChallenges } from 'src/db/schema';

export const OAUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_BYTES = 32;

export type OAuthChallengeProvider = 'google';

type ChallengeDatabase = Pick<DrizzleDB, 'delete' | 'insert'>;

const isOAuthChallengeProvider = (provider: string): provider is OAuthChallengeProvider =>
  provider === 'google';

const isRawChallenge = (challenge: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(challenge);

const hashChallenge = (challenge: string): string =>
  crypto.createHash('sha256').update(challenge).digest('hex');

@Injectable()
export class OAuthChallengeService {
  constructor(@Inject(DRIZZLE) private readonly db: ChallengeDatabase) {}

  async createChallenge(provider: OAuthChallengeProvider): Promise<string> {
    if (!isOAuthChallengeProvider(provider)) {
      throw new Error('Unsupported OAuth challenge provider');
    }

    const challenge = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');

    await this.db.insert(oauthChallenges).values({
      provider,
      challengeHash: hashChallenge(challenge),
      expiresAt: new Date(Date.now() + OAUTH_CHALLENGE_TTL_MS),
    });

    return challenge;
  }

  async verifyAndConsume(provider: OAuthChallengeProvider, challenge: string): Promise<boolean> {
    if (!isOAuthChallengeProvider(provider) || !isRawChallenge(challenge)) {
      return false;
    }

    const [consumed] = await this.db
      .delete(oauthChallenges)
      .where(
        and(
          eq(oauthChallenges.provider, provider),
          eq(oauthChallenges.challengeHash, hashChallenge(challenge)),
          gt(oauthChallenges.expiresAt, new Date()),
        ),
      )
      .returning({ id: oauthChallenges.id });

    return consumed !== undefined;
  }
}
