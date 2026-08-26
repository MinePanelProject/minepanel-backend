import type { Response } from 'express';
import type { PublicUser } from 'src/users/public-user';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { GoogleOAuthService } from './google-oauth.service';
import type { PreAuthRequest } from './guards/pre-auth.guard';
import type { OAuthChallengeService } from './oauth-challenge.service';
import type { RefreshTokenTtl } from './refresh-token-ttl';

type CookieResponse = Pick<Response, 'cookie'>;

const REFRESH_TTL: RefreshTokenTtl = { expiresIn: '7d', milliseconds: 7 * 24 * 60 * 60 * 1000 };

const publicUser: PublicUser = {
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  role: 'USER',
  status: 'ACTIVE',
  totpEnabled: false,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  googleId: null,
  githubId: null,
  minecraftVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthController', () => {
  let authService: Pick<AuthService, 'completeTwoFactorLogin' | 'loginUser'>;
  let googleOAuthService: Pick<GoogleOAuthService, 'linkAuthenticatedUser' | 'login'>;
  let oauthChallengeService: Pick<OAuthChallengeService, 'createChallenge'>;
  let controller: AuthController;
  let response: CookieResponse;

  beforeEach(() => {
    authService = {
      loginUser: jest.fn().mockResolvedValue({
        user: publicUser,
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
      completeTwoFactorLogin: jest.fn().mockResolvedValue({
        user: publicUser,
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    };
    googleOAuthService = {
      login: jest.fn(),
      linkAuthenticatedUser: jest.fn(),
    };
    oauthChallengeService = {
      createChallenge: jest.fn().mockResolvedValue('A'.repeat(43)),
    };
    // SAFETY: each mock exposes only the collaborator surface AuthController
    // consumes; the assertion bridges the structural mock to the injected type.
    const authServiceMock = authService as never;
    // SAFETY: each mock exposes only the collaborator surface AuthController
    // consumes; the assertion bridges the structural mock to the injected type.
    const googleOAuthServiceMock = googleOAuthService as never;
    // SAFETY: each mock exposes only the collaborator surface AuthController
    // consumes; the assertion bridges the structural mock to the injected type.
    const oauthChallengeServiceMock = oauthChallengeService as never;
    controller = new AuthController(
      authServiceMock,
      googleOAuthServiceMock,
      oauthChallengeServiceMock,
      REFRESH_TTL,
    );
    // SAFETY: cookie helpers only call response.cookie, which this test double provides.
    response = { cookie: jest.fn() };
  });

  it('sets raw tokens only in HttpOnly cookies and returns the public user', async () => {
    const result = await controller.login({ identifier: 'player', password: 'password' }, response);

    expect(result).toEqual(publicUser);
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
    expect(response.cookie).toHaveBeenCalledWith(
      'access_token',
      'access-token',
      expect.objectContaining({ httpOnly: true, maxAge: 15 * 60 * 1000 }),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh-token',
      expect.objectContaining({ httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }),
    );
  });

  it('completes two-factor login with HttpOnly cookies and a public user response', async () => {
    // SAFETY: verify2FA reads only preAuth.sub, preAuth.type, and response.cookie;
    // the partial request and response doubles cover those members.
    const result = await controller.verify2FA(
      // SAFETY: verify2FA reads only preAuth.sub and preAuth.type from this partial request.
      { preAuth: { sub: 'user-1', type: 'pre-auth' } } as PreAuthRequest,
      { token: '123456' },
      response,
    );

    expect(authService.completeTwoFactorLogin).toHaveBeenCalledWith('user-1', '123456');
    expect(result).toEqual(publicUser);
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('totpSecret');
    expect(result).not.toHaveProperty('totpBackupCodes');
    expect(result).not.toHaveProperty('tempPasswordHash');
    expect(response.cookie).toHaveBeenCalledWith(
      'access_token',
      'access-token',
      expect.objectContaining({ httpOnly: true, maxAge: 15 * 60 * 1000 }),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh-token',
      expect.objectContaining({ httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }),
    );
  });

  it('returns a two-factor challenge without setting authentication cookies', async () => {
    authService.loginUser = jest
      .fn()
      .mockResolvedValue({ requiresTwoFactor: true, preAuthToken: 'pre-auth-token' });

    await expect(
      controller.login({ identifier: 'player', password: 'password' }, response),
    ).resolves.toEqual({ requiresTwoFactor: true, preAuthToken: 'pre-auth-token' });
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('creates a Google-only challenge and returns the raw value once', async () => {
    await expect(controller.createOAuthChallenge({ provider: 'google' })).resolves.toEqual({
      challenge: 'A'.repeat(43),
    });
    expect(oauthChallengeService.createChallenge).toHaveBeenCalledWith('google');
  });
});
