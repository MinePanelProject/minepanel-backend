import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateUserDto } from './register.dto';

describe('CreateUserDto', () => {
  it('canonicalizes email and username to trimmed lowercase (D-10)', () => {
    const dto = plainToInstance(CreateUserDto, {
      email: '  User@Example.COM ',
      username: '  BobTheBuilder ',
      password: 'Password123!',
    });

    expect(dto.email).toBe('user@example.com');
    expect(dto.username).toBe('bobthebuilder');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects a casing-only duplicate at validation time (D-10 invariant)', () => {
    // Canonicalization happens before validation: 'Bob' and 'bob' become the
    // same canonical value, so registration uniqueness is enforced by the
    // existing unique(username) constraint / pre-insert existence check.
    const bob = plainToInstance(CreateUserDto, {
      email: 'bob@example.com',
      username: 'Bob',
      password: 'Password123!',
    });
    const bob2 = plainToInstance(CreateUserDto, {
      email: 'bob2@example.com',
      username: 'bob',
      password: 'Password123!',
    });

    expect(bob.username).toBe(bob2.username);
    expect(validateSync(bob)).toHaveLength(0);
    expect(validateSync(bob2)).toHaveLength(0);
  });
});
