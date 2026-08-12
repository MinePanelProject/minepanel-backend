import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenService } from 'src/auth/access-token.service';
import { IS_PUBLIC_KEY } from 'src/common/decorators/public.decorator';

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

    const request = context.switchToHttp().getRequest();
    const token = request.cookies?.access_token as string | undefined;

    if (!token) throw new UnauthorizedException();

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

      request.user = {
        id: principal.id,
        username: principal.username,
        role: principal.role,
        ...(principal.temporaryAuth ? { temporaryAuth: true } : {}),
      };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException();
    }

    return true;
  }
}
