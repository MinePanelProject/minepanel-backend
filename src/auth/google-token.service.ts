import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const GOOGLE_ISSUERS = {
  'accounts.google.com': true,
  'https://accounts.google.com': true,
} satisfies Record<string, boolean>;
const MAX_TOKEN_AGE_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 60;

export const GOOGLE_ID_TOKEN_VERIFIER = 'GOOGLE_ID_TOKEN_VERIFIER';

export type GoogleIdTokenVerifier = {
  verifyIdToken: (options: {
    idToken: string;
    audience: string;
  }) => Promise<{ getPayload: () => GoogleTokenPayload | undefined }>;
};

type GoogleTokenClaims = {
  sub: string;
  email: string;
  emailVerified: true;
  nonce: string;
  name?: string;
};

type GoogleTokenPayload = {
  iss?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  nonce?: unknown;
  name?: unknown;
  iat?: unknown;
  exp?: unknown;
};

@Injectable()
export class GoogleTokenService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(GOOGLE_ID_TOKEN_VERIFIER) private readonly verifier: GoogleIdTokenVerifier,
  ) {}

  isConfigured(): boolean {
    return this.googleClientId() !== undefined;
  }

  async verifyCredential(credential: string): Promise<GoogleTokenClaims> {
    const audience = this.googleClientId();
    if (!audience) {
      throw new ServiceUnavailableException({ error: 'GoogleOAuthUnavailable' });
    }

    try {
      const ticket = await this.verifier.verifyIdToken({ idToken: credential, audience });
      // The verifier already returns the parsed payload object; the guard below
      // narrows its known claim fields before they are returned as claims.
      const payload = ticket.getPayload();
      if (!payload || !this.hasRequiredClaims(payload)) {
        throw new UnauthorizedException({ error: 'InvalidGoogleCredential' });
      }

      if (payload.name === undefined) {
        return {
          sub: payload.sub,
          email: payload.email.trim().toLowerCase(),
          emailVerified: true,
          nonce: payload.nonce,
        };
      }
      return {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: true,
        nonce: payload.nonce,
        name: payload.name,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof UnauthorizedException) {
        throw error;
      }

      // Verification errors can embed the untrusted credential. Never log or expose them.
      throw new UnauthorizedException({ error: 'InvalidGoogleCredential' });
    }
  }

  private googleClientId(): string | undefined {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID')?.trim();
    return clientId || undefined;
  }

  private hasRequiredClaims(payload: GoogleTokenPayload): payload is {
    iss: string;
    sub: string;
    email: string;
    email_verified: true;
    nonce: string;
    iat: number;
    exp: number;
    name?: string;
  } {
    const now = Math.floor(Date.now() / 1000);
    return (
      typeof payload.iss === 'string' &&
      GOOGLE_ISSUERS[payload.iss] === true &&
      typeof payload.sub === 'string' &&
      payload.sub.trim().length > 0 &&
      typeof payload.email === 'string' &&
      payload.email.trim().length > 0 &&
      payload.email_verified === true &&
      typeof payload.nonce === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(payload.nonce) &&
      typeof payload.iat === 'number' &&
      Number.isInteger(payload.iat) &&
      payload.iat <= now + CLOCK_SKEW_SECONDS &&
      payload.iat >= now - MAX_TOKEN_AGE_SECONDS &&
      typeof payload.exp === 'number' &&
      Number.isInteger(payload.exp) &&
      payload.exp > now
    );
  }
}

export type { GoogleTokenClaims };
