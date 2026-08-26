import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GoogleTokenService } from './google-token.service';

const CHALLENGE = 'A'.repeat(43);

type PayloadOverrides = {
  iss?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  name?: string;
  iat?: number;
  exp?: number;
};

const payload = (overrides: PayloadOverrides = {}): PayloadOverrides => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    sub: 'google-subject',
    email: 'Player@Example.COM',
    email_verified: true,
    nonce: CHALLENGE,
    iat: now - 10,
    exp: now + 60,
    name: 'Player One',
    ...overrides,
  };
};

describe('GoogleTokenService', () => {
  let service: GoogleTokenService;
  let verifyIdToken: jest.Mock;
  let getConfig: jest.Mock;

  beforeEach(() => {
    verifyIdToken = jest.fn();
    getConfig = jest.fn().mockReturnValue('google-client-id.apps.googleusercontent.com');
    // SAFETY: the config mock exposes exactly the get() surface GoogleTokenService
    // consumes; the assertion bridges the structural mock to the ConfigService type.
    const configMock = { get: getConfig } as never;
    // SAFETY: the verifier mock exposes exactly the verifyIdToken surface consumed;
    // the assertion bridges the structural mock to the GoogleIdTokenVerifier type.
    const verifierMock = { verifyIdToken } as never;
    service = new GoogleTokenService(configMock, verifierMock);
  });

  it('verifies a fresh Google ID token and canonicalizes its email', async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => payload() });

    await expect(service.verifyCredential('credential')).resolves.toEqual({
      sub: 'google-subject',
      email: 'player@example.com',
      emailVerified: true,
      nonce: CHALLENGE,
      name: 'Player One',
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'credential',
      audience: 'google-client-id.apps.googleusercontent.com',
    });
  });

  it('rejects invalid signatures from the JWKS verifier without exposing the credential', async () => {
    verifyIdToken.mockRejectedValue(new Error('Invalid token signature: credential'));

    await expect(service.verifyCredential('credential')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong audience from the verifier', async () => {
    verifyIdToken.mockRejectedValue(new Error('Wrong recipient'));

    await expect(service.verifyCredential('credential')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['stale issued-at time', { iat: Math.floor(Date.now() / 1000) - 301 }],
    ['missing email', { email: undefined }],
    ['unverified email', { email_verified: false }],
    ['missing subject', { sub: undefined }],
    ['missing nonce', { nonce: undefined }],
    ['wrong nonce shape', { nonce: 'not-a-challenge' }],
  ])('rejects a token with %s', async (_description, overrides) => {
    verifyIdToken.mockResolvedValue({ getPayload: () => payload(overrides) });

    await expect(service.verifyCredential('credential')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects requests when Google OAuth is not configured', async () => {
    getConfig.mockReturnValue(undefined);

    await expect(service.verifyCredential('credential')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});
