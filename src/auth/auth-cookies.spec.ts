import express, { type Express } from 'express';
import request from 'supertest';
import { clearAuthCookies, setAuthCookies } from './auth-cookies';

const makeApp = (): Express => {
  const app = express();
  app.get('/set', (_req, res) => {
    setAuthCookies(res, { accessToken: 'access-value', refreshToken: 'refresh-value' });
    res.end();
  });
  app.get('/clear', (_req, res) => {
    clearAuthCookies(res);
    res.end();
  });
  return app;
};

const cookiesFor = async (path: string): Promise<string[]> => {
  const response = await request(makeApp()).get(path);
  return response.headers['set-cookie'] as string[];
};

describe('auth cookies', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('serializes the full CHIPS host-only contract on issuance', async () => {
      const cookies = await cookiesFor('/set');
      const access = cookies.find((cookie) => cookie.startsWith('access_token='));
      const refresh = cookies.find((cookie) => cookie.startsWith('refresh_token='));

      expect(access).toContain('access_token=access-value');
      expect(refresh).toContain('refresh_token=refresh-value');
      for (const cookie of [access, refresh]) {
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=None');
        expect(cookie).toContain('Partitioned');
        expect(cookie).toContain('Path=/');
        expect(cookie).not.toContain('Domain=');
      }
      expect(access).toContain('Max-Age=900');
      expect(refresh).toContain('Max-Age=604800');
    });

    it('repeats the same security and path attributes when clearing', async () => {
      const cookies = await cookiesFor('/clear');

      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie).toMatch(/^(access_token|refresh_token)=;/);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=None');
        expect(cookie).toContain('Partitioned');
        expect(cookie).toContain('Path=/');
        expect(cookie).not.toContain('Domain=');
      }
    });
  });

  describe('in development', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('omits Secure and Partitioned on issuance and clearing', async () => {
      for (const path of ['/set', '/clear']) {
        const cookies = await cookiesFor(path);

        for (const cookie of cookies) {
          expect(cookie).toContain('HttpOnly');
          expect(cookie).toContain('SameSite=Lax');
          expect(cookie).toContain('Path=/');
          expect(cookie).not.toContain('Secure');
          expect(cookie).not.toContain('Partitioned');
          expect(cookie).not.toContain('Domain=');
        }
      }
    });
  });
});
