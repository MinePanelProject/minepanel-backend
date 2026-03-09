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
      }>(token);

      // Get status and mustChangePassword
      const [user] = await this.db
        .select({ status: users.status, mustChangePassword: users.mustChangePassword })
        .from(users)
        .where(eq(users.id, payload.sub));

      if (user.status === 'PENDING') {
        throw new ForbiddenException({ error: 'AccountPending' });
      }

      if (user.status === 'BANNED') {
        throw new ForbiddenException({ error: 'AccountBanned' });
      }

      if (
        user.mustChangePassword &&
        !context.switchToHttp().getRequest().url.includes('/api/auth/password')
      ) {
        throw new ForbiddenException({ error: 'PasswordChangeRequired' });
      }

      request.user = { id: payload.sub, username: payload.username, role: payload.role };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException();
    }

    return true;
  }
}
