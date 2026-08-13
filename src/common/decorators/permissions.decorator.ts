import { SetMetadata } from '@nestjs/common';
import { type ModPermission } from 'src/db/schema';

export const REQUIRES_PERMISSION_KEY = 'requiresPermission';

export const RequiresPermission = (permission: ModPermission) =>
  SetMetadata(REQUIRES_PERMISSION_KEY, permission);
