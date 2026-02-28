import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    // route has no required role
    if (!roles) return true;

    // get request data
    const request = context.switchToHttp().getRequest<Request>();
    const role = (request.user as { role: string }).role;

    const match = roles.includes(role);

    if (!match) {
      throw new ForbiddenException();
    }

    return true;
  }
}
