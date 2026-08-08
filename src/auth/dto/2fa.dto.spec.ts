import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TwoFactorTokenDto } from './2fa.dto';

const validateToken = (token: unknown) =>
  validateSync(plainToInstance(TwoFactorTokenDto, { token }));

describe('TwoFactorTokenDto', () => {
  it.each(['123456', 'deadbeef-cafebabe'])('accepts valid two-factor token %s', (token) => {
    expect(validateToken(token)).toHaveLength(0);
  });

  it.each([
    '12345',
    '1234567',
    '123 456',
    ' deadbeef-cafebabe',
    'deadbeef-cafebabe ',
    'DEADBEEF-CAFEBABE',
    'deadbeef-cafebabe-extra',
    'arbitrary text',
    '123456789012345678',
  ])('rejects malformed or oversized two-factor token %s', (token) => {
    expect(validateToken(token)).not.toHaveLength(0);
  });
});
