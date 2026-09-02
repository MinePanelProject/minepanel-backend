import { HttpException, HttpStatus } from '@nestjs/common';
import { LoginAbuseService, type LoginAttemptContext } from './login-abuse.service';

const attempt = (identifier: string, source: string): LoginAttemptContext => ({
  identifier,
  source,
});

const expectRateLimited = async (service: LoginAbuseService, context: LoginAttemptContext) => {
  await expect(service.assertAllowed(context)).rejects.toMatchObject({
    response: { error: 'LoginRateLimited' },
    status: HttpStatus.TOO_MANY_REQUESTS,
  });
};

describe('LoginAbuseService', () => {
  it('limits repeated failures for one normalized account and source', async () => {
    const service = new LoginAbuseService();
    const context = attempt(' Player ', '198.51.100.10');

    for (let index = 0; index < 5; index += 1) {
      await expect(service.assertAllowed(context)).resolves.toBeUndefined();
      service.recordFailure(context);
    }

    await expectRateLimited(service, context);
  });

  it('does not hard-lock an account when failures come from many sources', async () => {
    const service = new LoginAbuseService();
    const context = attempt('player', '198.51.100.1');

    for (let index = 0; index < 20; index += 1) {
      const sourceContext = attempt('PLAYER', `198.51.100.${index + 1}`);
      await expect(service.assertAllowed(sourceContext)).resolves.toBeUndefined();
      service.recordFailure(sourceContext);
    }

    await expect(service.assertAllowed(context)).resolves.toBeUndefined();
  });

  it('keeps one source attack against many accounts bounded to independent keys', async () => {
    const service = new LoginAbuseService();

    for (let index = 0; index < 20; index += 1) {
      const context = attempt(`unknown-${index}`, '198.51.100.10');
      for (let failure = 0; failure < 5; failure += 1) service.recordFailure(context);
      await expectRateLimited(service, context);
    }
  });

  it('clears account and source penalties after successful authentication', async () => {
    const service = new LoginAbuseService();
    const context = attempt('player', '198.51.100.10');

    for (let index = 0; index < 5; index += 1) service.recordFailure(context);
    await expectRateLimited(service, context);

    service.recordSuccess(attempt(' PLAYER ', '198.51.100.10'));
    await expect(service.assertAllowed(context)).resolves.toBeUndefined();
  });

  it('expires failures without requiring unbounded cleanup work', async () => {
    jest.useFakeTimers();
    try {
      const service = new LoginAbuseService();
      const context = attempt('player', '198.51.100.10');
      for (let index = 0; index < 5; index += 1) service.recordFailure(context);
      await expectRateLimited(service, context);

      jest.advanceTimersByTime(15 * 60 * 1000);
      await expect(service.assertAllowed(context)).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the same safe error for rate-limit rejection regardless of account existence', async () => {
    const service = new LoginAbuseService();
    const knownLike = attempt('player', '198.51.100.10');
    const unknownLike = attempt('unknown', '198.51.100.10');
    for (let index = 0; index < 5; index += 1) {
      service.recordFailure(knownLike);
      service.recordFailure(unknownLike);
    }

    const errors = await Promise.allSettled([
      service.assertAllowed(knownLike),
      service.assertAllowed(unknownLike),
    ]);
    expect(errors).toEqual([
      expect.objectContaining({ reason: expect.any(HttpException), status: 'rejected' }),
      expect.objectContaining({ reason: expect.any(HttpException), status: 'rejected' }),
    ]);
  });
});
