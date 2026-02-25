import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from 'src/common/decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
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
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        username: string;
        role: string;
      }>(token);
      request.user = { id: payload.sub, username: payload.username, role: payload.role };
    } catch {
      throw new UnauthorizedException();
    }

    return true;
  }
}
