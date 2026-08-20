import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { REQUIRES_PERMISSION_KEY } from 'src/common/decorators/permissions.decorator';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type ModPermission, modPermissions } from 'src/db/schema';

const isNonEmptyString = (value: string | string[] | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Pick<DrizzleDB, 'select'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<ModPermission>(REQUIRES_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!permission) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user) {
      throw new ForbiddenException();
    }

    const role = request.user.role;
    if (role === 'ADMIN') return true;

    const routeId = request.params?.id;
    const serverId = isNonEmptyString(routeId) ? routeId : undefined;

    if (role !== 'MOD') {
      throw new ForbiddenException();
    }

    try {
      const conditions = [
        eq(modPermissions.userId, request.user.id),
        eq(modPermissions.permission, permission),
      ];

      if (serverId) {
        conditions.push(
          // SAFETY: drizzle's or() only returns undefined for an empty argument list;
          // both permission operands are always present here.
          or(isNull(modPermissions.serverId), eq(modPermissions.serverId, serverId)) as SQL,
        );
      } else {
        conditions.push(isNull(modPermissions.serverId));
      }

      const [row] = await this.db
        .select()
        .from(modPermissions)
        .where(and(...conditions))
        .limit(1);

      if (!row) {
        throw new ForbiddenException();
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException('Permission check unavailable');
    }
  }
}
