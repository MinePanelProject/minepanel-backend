import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PAIR_FAILURE_LIMIT = 5;
const MAX_PAIR_ENTRIES = 20_000;
const MAX_ACCOUNT_ENTRIES = 5_000;
const MAX_PROGRESSIVE_DELAY_MS = 100;

type FailureEntry = { failures: number; firstFailureAt: number; lastFailureAt: number };

export type LoginAttemptContext = { identifier: string; source: string };

const normalize = (value: string): string => value.trim().toLowerCase().slice(0, 254);

@Injectable()
export class LoginAbuseService {
  private readonly pairFailures = new Map<string, FailureEntry>();
  private readonly accountFailures = new Map<string, FailureEntry>();

  async assertAllowed(context: LoginAttemptContext): Promise<void> {
    const now = Date.now();
    this.prune(now);

    const pairKey = this.pairKey(context);
    const pair = this.pairFailures.get(pairKey);
    if (pair && pair.failures >= PAIR_FAILURE_LIMIT) {
      throw new HttpException({ error: 'LoginRateLimited' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const account = this.accountFailures.get(normalize(context.identifier));
    if (!account) return;

    const delayMs = Math.min(
      MAX_PROGRESSIVE_DELAY_MS,
      Math.max(0, account.failures - PAIR_FAILURE_LIMIT) * 10,
    );
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  recordFailure(context: LoginAttemptContext): void {
    const now = Date.now();
    this.prune(now);
    this.bump(this.pairFailures, this.pairKey(context), now, MAX_PAIR_ENTRIES);
    this.bump(this.accountFailures, normalize(context.identifier), now, MAX_ACCOUNT_ENTRIES);
  }

  recordSuccess(context: LoginAttemptContext): void {
    const accountKey = normalize(context.identifier);
    this.accountFailures.delete(accountKey);

    for (const key of this.pairFailures.keys()) {
      if (key.startsWith(`${accountKey}\u0000`)) this.pairFailures.delete(key);
    }
  }

  private pairKey(context: LoginAttemptContext): string {
    const source = createHash('sha256').update(context.source.slice(0, 256), 'utf8').digest('hex');
    return `${normalize(context.identifier)}\u0000${source}`;
  }

  private bump(
    entries: Map<string, FailureEntry>,
    key: string,
    now: number,
    maxEntries: number,
  ): void {
    const previous = entries.get(key);
    const entry =
      previous && now - previous.firstFailureAt < FAILURE_WINDOW_MS
        ? previous
        : { failures: 0, firstFailureAt: now, lastFailureAt: now };
    entries.set(key, {
      failures: entry.failures + 1,
      firstFailureAt: entry.firstFailureAt,
      lastFailureAt: now,
    });

    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.pairFailures) {
      if (now - entry.lastFailureAt >= FAILURE_WINDOW_MS) this.pairFailures.delete(key);
    }
    for (const [key, entry] of this.accountFailures) {
      if (now - entry.lastFailureAt >= FAILURE_WINDOW_MS) this.accountFailures.delete(key);
    }
  }
}
