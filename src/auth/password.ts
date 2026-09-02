import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

export const MAX_PASSWORD_BYTES = 72;

export const isPasswordWithinByteLimit = (data: unknown): data is string =>
  typeof data === 'string' && Buffer.byteLength(data, 'utf8') <= MAX_PASSWORD_BYTES;

export const assertPasswordWithinByteLimit = (data: string): void => {
  if (!isPasswordWithinByteLimit(data)) {
    throw new BadRequestException('Password must not exceed 72 UTF-8 bytes');
  }
};

export const compare = (data: string, encrypted: string): Promise<boolean> =>
  bcrypt.compare(data, encrypted);

export const hash = (data: string, saltOrRounds: string | number): Promise<string> =>
  bcrypt.hash(data, saltOrRounds);
