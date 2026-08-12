const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

const canonicalDatabaseTarget = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('database URL must be parseable');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('database URL must use postgres: or postgresql:');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database.length === 0) throw new Error('database URL must include a database name');

  let host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.length === 0) throw new Error('database URL must include a host');
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || LOOPBACK_IPV4.test(host)) {
    host = '127.0.0.1';
  }

  return `${host}:${parsed.port || '5432'}/${database}`;
};

export const assertSafeTestDatabase = (): string => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run database integration tests in production');
  }

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required');
  const testTarget = canonicalDatabaseTarget(testUrl);

  const ambientUrl = process.env.DATABASE_URL;
  if (ambientUrl && testTarget === canonicalDatabaseTarget(ambientUrl)) {
    throw new Error('TEST_DATABASE_URL must not target DATABASE_URL');
  }

  return testUrl;
};

export { canonicalDatabaseTarget };
