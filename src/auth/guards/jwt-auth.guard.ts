import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { IS_PUBLIC_KEY } from 'src/common/decorators/public.decorator';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { users } from 'src/db/schema';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    @Inject(DRIZZLE) private db: DrizzleDB,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = request.cookies?.access_token as string | undefined;

    if (!token) throw new UnauthorizedException();

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        username: string;
        role: string;
        type?: string;
        temporaryAuth?: boolean;
      }>(token);

      // the token type pins its purpose: a refresh or pre-auth token is
      // never a valid access token, reject before touching the database
      if (payload.type !== 'access') {
        throw new UnauthorizedException();
      }

      // Database is the authority for status and role so bans and role
      // changes take effect immediately, without waiting for the JWT to expire
      const [user] = await this.db
        .select({
          status: users.status,
          role: users.role,
          mustChangePassword: users.mustChangePassword,
        })
        .from(users)
        .where(eq(users.id, payload.sub));

      if (!user) {
        throw new UnauthorizedException();
      }

      if (user.status === 'PENDING') {
        throw new ForbiddenException({ error: 'AccountPending' });
      }

      if (user.status === 'BANNED') {
        throw new ForbiddenException({ error: 'AccountBanned' });
      }

      if (user.mustChangePassword) {
        const isPasswordChangeRoute =
          request.method === 'PATCH' && request.path === '/api/auth/password';

        // during forced recovery an ordinary access token is rejected on every
        // route; only a temporary-auth token may pass, and only on the exact
        // password-change route
        if (payload.temporaryAuth !== true) {
          throw new UnauthorizedException();
        }

        if (!isPasswordChangeRoute) {
          throw new ForbiddenException({ error: 'PasswordChangeRequired' });
        }
      } else if (payload.temporaryAuth) {
        throw new UnauthorizedException();
      }

      request.user = {
        id: payload.sub,
        username: payload.username,
        role: user.role,
        ...(payload.temporaryAuth ? { temporaryAuth: true } : {}),
      };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException();
    }

    return true;
  }
}
