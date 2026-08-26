import { DEFAULT_REFRESH_TOKEN_TTL, parseRefreshTokenTtl } from './refresh-token-ttl';

describe('parseRefreshTokenTtl', () => {
  it('falls back to the documented 7d default when the env var is absent', () => {
    expect(parseRefreshTokenTtl(undefined)).toEqual({
      expiresIn: '7d',
      milliseconds: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it('exports the same default the documentation and setup wizards write', () => {
    expect(DEFAULT_REFRESH_TOKEN_TTL).toBe('7d');
  });

  it('parses every supported duration unit', () => {
    expect(parseRefreshTokenTtl('500ms')).toEqual({ expiresIn: '500ms', milliseconds: 500 });
    expect(parseRefreshTokenTtl('45s')).toEqual({ expiresIn: '45s', milliseconds: 45_000 });
    expect(parseRefreshTokenTtl('90m')).toEqual({ expiresIn: '90m', milliseconds: 90 * 60_000 });
    expect(parseRefreshTokenTtl('12h')).toEqual({ expiresIn: '12h', milliseconds: 12 * 3_600_000 });
    expect(parseRefreshTokenTtl('2w')).toEqual({ expiresIn: '2w', milliseconds: 1_209_600_000 });
  });

  it('normalizes unit case from the pattern', () => {
    expect(parseRefreshTokenTtl('7D')).toEqual({ expiresIn: '7d', milliseconds: 604_800_000 });
  });

  it.each([
    ['', 'empty string'],
    [' ', 'whitespace'],
    [' 7d', 'leading whitespace'],
    ['7d ', 'trailing whitespace'],
    ['7 days', 'unit with spaces'],
    ['days', 'unit without amount'],
    ['d', 'bare unit'],
    ['0d', 'zero amount'],
    ['-1d', 'negative amount'],
    ['1.5d', 'fractional amount'],
    ['1d2h', 'compound duration'],
    ['7', 'amount without unit'],
    ['7 dd', 'unknown unit'],
    ['seven', 'word duration'],
  ])('rejects %s (%s) instead of substituting a default', (_value, _label) => {
    expect(() => parseRefreshTokenTtl(_value)).toThrow('Invalid JWT_REFRESH_EXPIRES_IN');
  });
});
