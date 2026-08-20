import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { users } from 'src/db/schema';

export type AccessTokenPrincipal = {
  id: string;
  username: string;
  role: string;
  mustChangePassword: boolean;
  temporaryAuth: boolean;
  exp: number;
};

const MAX_EXP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

type AccessTokenClaims = {
  sub: string;
  username: string;
  type: 'access';
  temporaryAuth: boolean | undefined;
  exp: number;
};

type AccessTokenClaimsCandidate = {
  sub?: string;
  username?: string;
  type?: string;
  temporaryAuth?: boolean;
  exp?: number;
};
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DRIZZLE) private readonly db: Pick<DrizzleDB, 'select'>,
  ) {}
  async verify(token: string): Promise<AccessTokenPrincipal> {
    let payload: AccessTokenClaimsCandidate;

    try {
      payload = await this.jwtService.verifyAsync<AccessTokenClaimsCandidate>(token);
    } catch {
      throw new UnauthorizedException();
    }

    if (!this.isValidPayload(payload)) {
      throw new UnauthorizedException();
    }

    let user: { status: string; role: string; mustChangePassword: boolean } | undefined;

    try {
      [user] = await this.db
        .select({
          status: users.status,
          role: users.role,
          mustChangePassword: users.mustChangePassword,
        })
        .from(users)
        .where(eq(users.id, payload.sub));
    } catch {
      // DB-unavailable/query failure fails closed: without DB-current status
      // the token cannot be authorized.
      throw new UnauthorizedException();
    }

    if (!user) {
      throw new UnauthorizedException();
    }

    if (user.status === 'PENDING') {
      throw new ForbiddenException({ error: 'AccountPending' });
    }

    if (user.status === 'BANNED') {
      throw new ForbiddenException({ error: 'AccountBanned' });
    }

    return {
      id: payload.sub,
      username: payload.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      temporaryAuth: payload.temporaryAuth === true,
      exp: payload.exp * 1000,
    };
  }

  private isValidPayload(candidate: AccessTokenClaimsCandidate): candidate is AccessTokenClaims {
    if (typeof candidate.sub !== 'string' || candidate.sub.length === 0) {
      return false;
    }

    if (typeof candidate.username !== 'string') {
      return false;
    }

    if (candidate.type !== 'access') {
      return false;
    }

    if (
      typeof candidate.exp !== 'number' ||
      !Number.isFinite(candidate.exp) ||
      !Number.isInteger(candidate.exp) ||
      candidate.exp <= 0 ||
      candidate.exp > MAX_EXP_SECONDS
    ) {
      return false;
    }

    const temporaryAuth = candidate.temporaryAuth;

    if (temporaryAuth !== undefined && typeof temporaryAuth !== 'boolean') {
      return false;
    }

    return true;
  }
}
