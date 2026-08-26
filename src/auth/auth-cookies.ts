import type { CookieOptions, Response } from 'express';
import type { AuthTokens } from './auth.service';
import type { RefreshTokenTtl } from './refresh-token-ttl';

const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

// express@5.2 serializes `partitioned` through cookie@0.7 at runtime, but its
// bundled CookieOptions type does not declare the field yet
type SessionCookieOptions = CookieOptions & { partitioned?: boolean };

// SPEC §8.2 contract: production session cookies are host-only (no Domain) and
// CHIPS-partitioned for the cross-origin hosted frontend; development keeps
// Lax without Secure/Partitioned. Clearing repeats the same security and path
// attributes so browsers evict the exact cookie that was set.
const sessionCookieOptions = (maxAge: number): SessionCookieOptions =>
  process.env.NODE_ENV === 'production'
    ? {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        partitioned: true,
        path: '/',
        maxAge,
      }
    : { httpOnly: true, sameSite: 'lax', path: '/', maxAge };

export const setAccessTokenCookie = (res: Pick<Response, 'cookie'>, accessToken: string): void => {
  res.cookie('access_token', accessToken, sessionCookieOptions(ACCESS_TOKEN_COOKIE_MAX_AGE_MS));
};

export const setRefreshTokenCookie = (
  res: Pick<Response, 'cookie'>,
  refreshToken: string,
  refreshTokenTtl: RefreshTokenTtl,
): void => {
  res.cookie('refresh_token', refreshToken, sessionCookieOptions(refreshTokenTtl.milliseconds));
};

export const setAuthCookies = (
  res: Pick<Response, 'cookie'>,
  tokens: Pick<AuthTokens, 'accessToken' | 'refreshToken'>,
  refreshTokenTtl: RefreshTokenTtl,
): void => {
  setAccessTokenCookie(res, tokens.accessToken);
  setRefreshTokenCookie(res, tokens.refreshToken, refreshTokenTtl);
};

export const clearAuthCookies = (res: Pick<Response, 'cookie'>): void => {
  res.cookie('access_token', '', sessionCookieOptions(0));
  res.cookie('refresh_token', '', sessionCookieOptions(0));
};
