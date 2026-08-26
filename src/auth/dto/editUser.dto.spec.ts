import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EditUserDto } from './editUser.dto';

describe('EditUserDto', () => {
  it('canonicalizes username changes to trimmed lowercase (D-10)', () => {
    const dto = plainToInstance(EditUserDto, { username: '  BobTheBuilder ' });

    expect(dto.username).toBe('bobthebuilder');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('cannot introduce a casing collision: all casings canonicalize to one value', () => {
    const bob = plainToInstance(EditUserDto, { username: 'Bob' });
    const bobLower = plainToInstance(EditUserDto, { username: 'bob' });

    expect(bob.username).toBe(bobLower.username);
  });
});
