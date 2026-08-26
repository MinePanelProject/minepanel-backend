import { OAuthChallengeService } from './oauth-challenge.service';

type ChallengeRow = {
  challengeHash: string;
  expiresAt: Date;
  provider: string;
};

describe('OAuthChallengeService', () => {
  let insertValues: jest.Mock;
  let returning: jest.Mock;
  let service: OAuthChallengeService;

  beforeEach(() => {
    insertValues = jest.fn().mockResolvedValue(undefined);
    returning = jest.fn();
    const db = {
      insert: jest.fn(() => ({ values: insertValues })),
      delete: jest.fn(() => ({
        where: jest.fn(() => ({ returning })),
      })),
    };

    // SAFETY: the test-producer db mock exposes the insert().values() and
    // delete().where().returning() surface the service consumes; 'never'
    // widens only the DrizzleDB compile-time requirement for this fixture.
    service = new OAuthChallengeService(db as never);
  });

  it('stores only a SHA-256 digest and returns the raw challenge once', async () => {
    const challenge = await service.createChallenge('google');

    // SAFETY: insertValues records the exact values() payload the mocked insert
    // producer received; the cast narrows the jest.Mock call record to the
    // ChallengeRow shape the service is asserted to persist.
    const [stored] = insertValues.mock.calls[0] as [ChallengeRow];
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.provider).toBe('google');
    expect(stored.challengeHash).toHaveLength(64);
    expect(stored.challengeHash).not.toBe(challenge);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(4 * 60 * 1000);
  });

  it('consumes a valid challenge exactly once', async () => {
    const challenge = await service.createChallenge('google');
    returning.mockResolvedValueOnce([{ id: 'challenge-1' }]).mockResolvedValueOnce([]);

    await expect(service.verifyAndConsume('google', challenge)).resolves.toBe(true);
    await expect(service.verifyAndConsume('google', challenge)).resolves.toBe(false);
  });

  it('rejects expired challenges and provider mismatches', async () => {
    const challenge = await service.createChallenge('google');
    returning.mockResolvedValue([]);

    await expect(service.verifyAndConsume('google', challenge)).resolves.toBe(false);
    // SAFETY: the literal 'github' exercises the provider-mismatch rejection at
    // the service boundary; 'never' widens only the compile-time union for this
    // negative input.
    await expect(service.verifyAndConsume('github' as never, challenge)).resolves.toBe(false);
  });

  it('rejects malformed challenges without querying the database', async () => {
    await expect(service.verifyAndConsume('google', 'not-a-challenge')).resolves.toBe(false);
    expect(returning).not.toHaveBeenCalled();
  });
});
