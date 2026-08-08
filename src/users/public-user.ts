import type { User } from 'src/db/schema';

export type PublicUser = Omit<
  User,
  'passwordHash' | 'tempPasswordHash' | 'totpBackupCodes' | 'totpSecret'
>;

export const toPublicUser = ({
  passwordHash: _passwordHash,
  tempPasswordHash: _tempPasswordHash,
  totpBackupCodes: _totpBackupCodes,
  totpSecret: _totpSecret,
  ...user
}: User): PublicUser => user;
