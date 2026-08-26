import { Injectable, UnauthorizedException } from '@nestjs/common';
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { AuthService, type AuthTokens } from './auth.service';
import { GoogleTokenService } from './google-token.service';
import { IdentityService } from './identity.service';
import { OAuthChallengeService } from './oauth-challenge.service';

export type GoogleLoginOutcome =
  | { status: 'Authenticated'; session: AuthTokens }
  | { status: 'LinkConfirmationRequired' };

@Injectable()
export class GoogleOAuthService {
  constructor(
    private readonly authService: AuthService,
    private readonly googleTokenService: GoogleTokenService,
    private readonly identityService: IdentityService,
    private readonly oauthChallengeService: OAuthChallengeService,
  ) {}

  async login(credential: string): Promise<GoogleLoginOutcome> {
    const claims = await this.googleTokenService.verifyCredential(credential);
    const consumed = await this.oauthChallengeService.verifyAndConsume('google', claims.nonce);
    if (!consumed) {
      throw new UnauthorizedException({ error: 'InvalidGoogleChallenge' });
    }

    const resolution = await this.identityService.resolveProviderIdentity({
      provider: 'google',
      providerId: claims.sub,
      email: claims.email,
      username: this.usernameForClaims(claims.email, claims.name),
    });

    if (resolution.kind === 'linkConfirmationRequired') {
      return { status: 'LinkConfirmationRequired' };
    }

    return {
      status: 'Authenticated',
      session: await this.authService.issueProviderSession(resolution.user),
    };
  }

  async linkAuthenticatedUser(userId: string, credential: string): Promise<PublicUser> {
    const claims = await this.googleTokenService.verifyCredential(credential);
    const consumed = await this.oauthChallengeService.verifyAndConsume('google', claims.nonce);
    if (!consumed) {
      throw new UnauthorizedException({ error: 'InvalidGoogleChallenge' });
    }

    const user = await this.identityService.linkGoogleIdentity(userId, claims.sub);
    return toPublicUser(user);
  }

  private usernameForClaims(email: string, displayName?: string): string {
    const source = displayName?.trim() || email.slice(0, email.indexOf('@'));
    const normalized = source
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);

    return (normalized || 'user').padEnd(3, '_');
  }
}
