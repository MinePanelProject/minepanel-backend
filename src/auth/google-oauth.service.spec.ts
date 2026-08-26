import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { User } from 'src/db/schema';
import type { AuthService, AuthTokens } from './auth.service';
import { GoogleOAuthService } from './google-oauth.service';
import type { GoogleTokenService } from './google-token.service';
import type { IdentityService } from './identity.service';
import type { OAuthChallengeService } from './oauth-challenge.service';

const CHALLENGE = 'A'.repeat(43);

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'player@example.com',
  username: 'player',
  passwordHash: null,
  googleId: 'google-subject',
  githubId: null,
  role: 'USER',
  status: 'ACTIVE',
  totpSecret: null,
  totpEnabled: false,
  totpBackupCodes: null,
  tempPasswordHash: null,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  minecraftVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('GoogleOAuthService', () => {
  let authService: Pick<AuthService, 'issueProviderSession'>;
  let googleTokenService: Pick<GoogleTokenService, 'verifyCredential'>;
  let identityService: Pick<IdentityService, 'linkGoogleIdentity' | 'resolveProviderIdentity'>;
  let oauthChallengeService: Pick<OAuthChallengeService, 'verifyAndConsume'>;
  let service: GoogleOAuthService;

  beforeEach(() => {
    authService = { issueProviderSession: jest.fn() };
    googleTokenService = {
      verifyCredential: jest.fn().mockResolvedValue({
        sub: 'google-subject',
        email: 'player@example.com',
        emailVerified: true,
        nonce: CHALLENGE,
        name: 'Player Name!',
      }),
    };
    identityService = {
      resolveProviderIdentity: jest
        .fn()
        .mockResolvedValue({ kind: 'authenticated', user: makeUser() }),
      linkGoogleIdentity: jest.fn().mockResolvedValue(makeUser()),
    };
    oauthChallengeService = { verifyAndConsume: jest.fn().mockResolvedValue(true) };
    // SAFETY: auth mock exposes only the collaborator surface GoogleOAuthService consumes.
    const authServiceMock = authService as never;
    // SAFETY: token mock exposes only the collaborator surface GoogleOAuthService consumes.
    const googleTokenServiceMock = googleTokenService as never;
    // SAFETY: identity mock exposes only the collaborator surface GoogleOAuthService consumes.
    const identityServiceMock = identityService as never;
    // SAFETY: challenge mock exposes only the collaborator surface GoogleOAuthService consumes.
    const oauthChallengeServiceMock = oauthChallengeService as never;
    service = new GoogleOAuthService(
      authServiceMock,
      googleTokenServiceMock,
      identityServiceMock,
      oauthChallengeServiceMock,
    );
  });

  it.each([
    'authenticated',
    'created',
  ] as const)('issues the normal session for a %s provider identity', async (kind) => {
    const session: AuthTokens = {
      user: makeUser(),
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    };
    identityService.resolveProviderIdentity = jest
      .fn()
      .mockResolvedValue({ kind, user: makeUser() });
    authService.issueProviderSession = jest.fn().mockResolvedValue(session);

    await expect(service.login('credential')).resolves.toEqual({
      status: 'Authenticated',
      session,
    });
    expect(oauthChallengeService.verifyAndConsume).toHaveBeenCalledWith('google', CHALLENGE);
    expect(identityService.resolveProviderIdentity).toHaveBeenCalledWith({
      provider: 'google',
      providerId: 'google-subject',
      email: 'player@example.com',
      username: 'player_name',
    });
    expect(authService.issueProviderSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  it('returns link confirmation without issuing a session or leaking provider credentials', async () => {
    identityService.resolveProviderIdentity = jest
      .fn()
      .mockResolvedValue({ kind: 'linkConfirmationRequired', user: makeUser({ googleId: null }) });

    await expect(service.login('credential')).resolves.toEqual({
      status: 'LinkConfirmationRequired',
    });
    expect(authService.issueProviderSession).not.toHaveBeenCalled();
  });

  it('rejects a missing or consumed challenge before identity resolution', async () => {
    oauthChallengeService.verifyAndConsume = jest.fn().mockResolvedValue(false);

    await expect(service.login('credential')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(identityService.resolveProviderIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['pending account', new ForbiddenException({ error: 'AccountPending' })],
    ['banned account', new ForbiddenException({ error: 'AccountBanned' })],
  ])('does not create a session for a %s', async (_description, error) => {
    authService.issueProviderSession = jest.fn().mockRejectedValue(error);

    await expect(service.login('credential')).rejects.toBe(error);
  });

  it('links an authenticated account only after consuming a fresh challenge', async () => {
    const linked = makeUser({ googleId: 'google-subject' });
    identityService.linkGoogleIdentity = jest.fn().mockResolvedValue(linked);

    await expect(service.linkAuthenticatedUser('user-1', 'credential')).resolves.toMatchObject({
      id: linked.id,
      googleId: linked.googleId,
    });
    expect(identityService.linkGoogleIdentity).toHaveBeenCalledWith('user-1', 'google-subject');
  });

  it('does not allow a consumed challenge to link twice', async () => {
    oauthChallengeService.verifyAndConsume = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    await expect(service.linkAuthenticatedUser('user-1', 'credential')).resolves.toMatchObject({
      id: 'user-1',
      googleId: 'google-subject',
    });
    await expect(service.linkAuthenticatedUser('user-1', 'credential')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(identityService.linkGoogleIdentity).toHaveBeenCalledTimes(1);
  });
});
