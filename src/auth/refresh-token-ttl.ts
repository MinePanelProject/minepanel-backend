import type { StringValue } from 'ms';

export const REFRESH_TOKEN_TTL = Symbol('REFRESH_TOKEN_TTL');

export type RefreshTokenTtl = {
  expiresIn: StringValue;
  milliseconds: number;
};

const DURATION_UNITS_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

type DurationUnit = keyof typeof DURATION_UNITS_MS;

const DURATION_PATTERN = /^(?<amount>[1-9]\d*)(?<unit>ms|s|m|h|d|w)$/iu;

// documented default when JWT_REFRESH_EXPIRES_IN is absent: .env.example, the
// setup wizards, and docker-compose all write "7d"
export const DEFAULT_REFRESH_TOKEN_TTL = '7d';

export const parseRefreshTokenTtl = (value: string | undefined): RefreshTokenTtl => {
  // an absent env var falls back to the documented default; any present value
  // must parse exactly or boot fails (never silently substitute another TTL)
  const resolved = value ?? DEFAULT_REFRESH_TOKEN_TTL;

  if (typeof resolved !== 'string' || resolved.length === 0 || resolved !== resolved.trim()) {
    throw new Error('Invalid JWT_REFRESH_EXPIRES_IN');
  }

  const match = DURATION_PATTERN.exec(resolved);
  if (!match?.groups) {
    throw new Error('Invalid JWT_REFRESH_EXPIRES_IN');
  }

  const amount = Number(match.groups.amount);
  // SAFETY: DURATION_PATTERN is the producer; it restricts the unit alternation
  // to exactly the DurationUnit keys, so the lowering cannot escape that set.
  const unit = match.groups.unit.toLowerCase() as DurationUnit;
  const milliseconds = amount * DURATION_UNITS_MS[unit];

  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(milliseconds)) {
    throw new Error('Invalid JWT_REFRESH_EXPIRES_IN');
  }

  // SAFETY: ms.StringValue allows `${number}${UnitAnyCase}`; DURATION_PATTERN is
  // the producer and restricts input to compact units, so `${amount}${unit}` fits.
  return { expiresIn: `${amount}${unit}` as StringValue, milliseconds };
};
