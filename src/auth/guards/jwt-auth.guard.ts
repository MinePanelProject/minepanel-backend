import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenService } from 'src/auth/access-token.service';
import { IS_PUBLIC_KEY } from 'src/common/decorators/public.decorator';

type GuardedUser = { id: string; username: string; role: string; temporaryAuth?: boolean };
type GuardedRequest = Request & {
  cookies?: { access_token?: unknown };
  user?: GuardedUser;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private accessTokenService: AccessTokenService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const token = request.cookies?.access_token;

    if (!isNonEmptyString(token)) throw new UnauthorizedException();

    try {
      const principal = await this.accessTokenService.verify(token);

      if (principal.mustChangePassword) {
        const isPasswordChangeRoute =
          request.method === 'PATCH' && request.path === '/api/auth/password';

        if (principal.temporaryAuth !== true) {
          throw new UnauthorizedException();
        }

        if (!isPasswordChangeRoute) {
          throw new ForbiddenException({ error: 'PasswordChangeRequired' });
        }
      } else if (principal.temporaryAuth) {
        throw new UnauthorizedException();
      }

      const authenticatedUser: GuardedUser = {
        id: principal.id,
        username: principal.username,
        role: principal.role,
      };
      if (principal.temporaryAuth) {
        authenticatedUser.temporaryAuth = true;
      }
      request.user = authenticatedUser;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException();
    }

    return true;
  }
}
