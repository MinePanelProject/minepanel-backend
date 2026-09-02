import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginUserDto } from './login.dto';
import { UpdatePasswordDTO } from './updatePw.dto';

const invalidPasswordErrors = async (password: string) => {
  const dto = plainToInstance(LoginUserDto, { identifier: 'player', password });
  return validate(dto);
};

const invalidPasswordChangeErrors = async (password: string) => {
  const dto = plainToInstance(UpdatePasswordDTO, {
    oldPassword: password,
    newPassword: password,
  });
  return validate(dto);
};

describe('password UTF-8 byte limits', () => {
  it('accepts an ASCII password at the 72-byte boundary', async () => {
    await expect(invalidPasswordErrors('a'.repeat(72))).resolves.toHaveLength(0);
  });

  it('rejects an ASCII password above the 72-byte boundary', async () => {
    await expect(invalidPasswordErrors('a'.repeat(73))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'password' })]),
    );
  });

  it('measures multi-byte Unicode passwords as UTF-8 bytes', async () => {
    await expect(invalidPasswordErrors('😀'.repeat(18))).resolves.toHaveLength(0);
    await expect(invalidPasswordErrors('😀'.repeat(19))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'password' })]),
    );
  });

  it('applies the same byte limit to password changes', async () => {
    const errors = await invalidPasswordChangeErrors('é'.repeat(37));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'oldPassword' }),
        expect.objectContaining({ property: 'newPassword' }),
      ]),
    );
  });
});
