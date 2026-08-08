import type { Response } from 'express';
import type { PublicUser } from 'src/users/public-user';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { PreAuthRequest } from './guards/pre-auth.guard';

jest.mock('./auth.service', () => ({ AuthService: class AuthService {} }));

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
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthController', () => {
  let authService: Pick<AuthService, 'completeTwoFactorLogin' | 'loginUser'>;
  let controller: AuthController;
  let response: Pick<Response, 'cookie'>;

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
    controller = new AuthController(authService as AuthService);
    response = { cookie: jest.fn() };
  });

  it('sets raw tokens only in HttpOnly cookies and returns the public user', async () => {
    const result = await controller.login(
      { identifier: 'player', password: 'password' },
      response as Response,
    );

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
    const result = await controller.verify2FA(
      { preAuth: { sub: 'user-1', type: 'pre-auth' } } as PreAuthRequest,
      { token: '123456' },
      response as Response,
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
      controller.login({ identifier: 'player', password: 'password' }, response as Response),
    ).resolves.toEqual({ requiresTwoFactor: true, preAuthToken: 'pre-auth-token' });
    expect(response.cookie).not.toHaveBeenCalled();
  });
});
