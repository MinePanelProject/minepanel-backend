import { type CorsConfig, getCanonicalCorsOrigin } from './cors-origin';

type ConfigValue = string | null;

const config = (value: ConfigValue): CorsConfig => ({
  get: jest.fn().mockReturnValue(value),
});

describe('getCanonicalCorsOrigin', () => {
  it('uses localhost:5173 by default', () => {
    // SAFETY: the default-origin branch only calls service.get(key, fallback), which this
    // double implements.
    const service = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };

    expect(getCanonicalCorsOrigin(service)).toBe('http://localhost:5173');
  });

  it.each([
    ' http://example.test',
    'http://example.test ',
    '*',
    'null',
    'http://a.test,http://b.test',
    'http://user:pass@example.test',
    'http://example.test/path',
    'http://example.test/',
    'http://example.test/?query=1',
    'http://example.test/#fragment',
    'ftp://example.test',
    'example.test',
    '',
  ])('rejects invalid origin %s', (value) => {
    expect(() => getCanonicalCorsOrigin(config(value))).toThrow();
  });

  it.each([
    ['http://example.test', 'http://example.test'],
    ['https://example.test:443', 'https://example.test'],
    ['http://example.test:80', 'http://example.test'],
    ['http://[::1]:5173', 'http://[::1]:5173'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(getCanonicalCorsOrigin(config(value))).toBe(expected);
  });

  it('fails closed when the configuration provider returns a non-string', () => {
    expect(() => getCanonicalCorsOrigin(config(null))).toThrow('must be a string');
  });
});
