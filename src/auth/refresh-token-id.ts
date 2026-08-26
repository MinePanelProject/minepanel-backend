import crypto from 'node:crypto';

export const createRefreshTokenId = (): string => crypto.randomBytes(32).toString('base64url');

export const hashRefreshTokenId = (tokenId: string): string =>
  crypto.createHash('sha256').update(tokenId).digest('hex');
