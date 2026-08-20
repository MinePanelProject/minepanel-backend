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
  temporaryAuth?: boolean;
  exp: number;
};

type AccessTokenClaimsCandidate = {
  sub?: unknown;
  username?: unknown;
  type?: unknown;
  temporaryAuth?: unknown;
  exp?: unknown;
};

const parseAccessTokenClaims = (candidate: unknown): AccessTokenClaims | null => {
  try {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }

    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }

    const claims =
      /* SAFETY: JwtService.verifyAsync or JSON decoding is the external producer; null,
      plain-object prototype, and own-field checks validate this intermediate typed view.
      The typed object is used only for field validation before constructing the domain value. */
      candidate as AccessTokenClaimsCandidate;
    if (
      !Object.hasOwn(claims, 'sub') ||
      !Object.hasOwn(claims, 'username') ||
      !Object.hasOwn(claims, 'type') ||
      !Object.hasOwn(claims, 'exp')
    ) {
      return null;
    }

    const { sub, username, type, exp } = claims;
    const temporaryAuth = Object.hasOwn(claims, 'temporaryAuth') ? claims.temporaryAuth : undefined;

    if (
      typeof sub !== 'string' ||
      sub.length === 0 ||
      typeof username !== 'string' ||
      type !== 'access' ||
      (temporaryAuth !== undefined && typeof temporaryAuth !== 'boolean') ||
      typeof exp !== 'number' ||
      !Number.isFinite(exp) ||
      !Number.isInteger(exp) ||
      exp <= 0 ||
      exp > MAX_EXP_SECONDS
    ) {
      return null;
    }

    const parsedClaims: AccessTokenClaims = {
      sub,
      username,
      type,
      exp,
    };
    if (temporaryAuth !== undefined) parsedClaims.temporaryAuth = temporaryAuth;
    return parsedClaims;
  } catch {
    return null;
  }
};

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DRIZZLE) private readonly db: Pick<DrizzleDB, 'select'>,
  ) {}
  async verify(token: string): Promise<AccessTokenPrincipal> {
    let verifiedPayload: unknown;

    try {
      verifiedPayload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    const payload = parseAccessTokenClaims(verifiedPayload);
    if (payload === null) {
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
}
