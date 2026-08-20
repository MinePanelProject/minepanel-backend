export type CorsConfig = { get: (key: string, fallback: string) => string | undefined };

const DEFAULT_ORIGIN = 'http://localhost:5173';

const isStringValue = (value: string | undefined): value is string => typeof value === 'string';

export const getCanonicalCorsOrigin = (configService: CorsConfig): string => {
  const raw = configService.get('CORS_ORIGIN', DEFAULT_ORIGIN);

  if (!isStringValue(raw)) {
    throw new Error('CORS_ORIGIN must be a string');
  }

  if (raw !== raw.trim()) {
    throw new Error('CORS_ORIGIN must not have surrounding whitespace');
  }

  if (raw.length === 0) {
    throw new Error('CORS_ORIGIN must not be empty');
  }

  if (raw.includes(',')) {
    throw new Error('CORS_ORIGIN must be exactly one origin, not a comma-separated list');
  }

  if (raw === 'null' || raw === '*' || raw.endsWith('/')) {
    throw new Error('CORS_ORIGIN must be an absolute http(s) origin');
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CORS_ORIGIN is not a valid URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CORS_ORIGIN must use http: or https:');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('CORS_ORIGIN must not contain credentials');
  }

  if (parsed.pathname !== '/') {
    throw new Error('CORS_ORIGIN must not contain a path');
  }

  if (parsed.search !== '') {
    throw new Error('CORS_ORIGIN must not contain a query string');
  }

  if (parsed.hash !== '') {
    throw new Error('CORS_ORIGIN must not contain a fragment');
  }

  return parsed.origin;
};
