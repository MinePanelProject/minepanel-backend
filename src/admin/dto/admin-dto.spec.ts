import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListUsersQueryDto } from './list-users-query.dto';
import { UpdateUserRoleDto } from './update-user-role.dto';
import { UpdateUserStatusDto } from './update-user-status.dto';
import { UserParamDto } from './user-param.dto';

describe('ListUsersQueryDto', () => {
  it('accepts an empty query (no filters)', () => {
    expect(validateSync(plainToInstance(ListUsersQueryDto, {}))).toHaveLength(0);
  });

  it.each(['ACTIVE', 'PENDING', 'BANNED'])('accepts valid status %s', (status) => {
    expect(validateSync(plainToInstance(ListUsersQueryDto, { status }))).toHaveLength(0);
  });

  it.each(['ADMIN', 'MOD', 'USER'])('accepts valid role %s', (role) => {
    expect(validateSync(plainToInstance(ListUsersQueryDto, { role }))).toHaveLength(0);
  });

  it.each(['BANNED ', 'active', 'DELETED'])('rejects invalid status %s', (status) => {
    expect(validateSync(plainToInstance(ListUsersQueryDto, { status }))).not.toHaveLength(0);
  });

  it.each(['OWNER', 'admin'])('rejects invalid role %s', (role) => {
    expect(validateSync(plainToInstance(ListUsersQueryDto, { role }))).not.toHaveLength(0);
  });

  it('rejects unknown query parameters', () => {
    expect(
      validateSync(plainToInstance(ListUsersQueryDto, { page: '1' }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).not.toHaveLength(0);
  });
});

describe('UpdateUserStatusDto', () => {
  it.each(['ACTIVE', 'PENDING', 'BANNED'])('accepts valid status %s', (status) => {
    expect(validateSync(plainToInstance(UpdateUserStatusDto, { status }))).toHaveLength(0);
  });

  it.each([undefined, 'banned', 'BANNED ', ''])('rejects invalid status %s', (status) => {
    expect(validateSync(plainToInstance(UpdateUserStatusDto, { status }))).not.toHaveLength(0);
  });
});

describe('UpdateUserRoleDto', () => {
  it.each(['ADMIN', 'MOD', 'USER'])('accepts valid role %s', (role) => {
    expect(validateSync(plainToInstance(UpdateUserRoleDto, { role }))).toHaveLength(0);
  });

  it.each([undefined, 'admin', 'ADMIN ', ''])('rejects invalid role %s', (role) => {
    expect(validateSync(plainToInstance(UpdateUserRoleDto, { role }))).not.toHaveLength(0);
  });
});

describe('UserParamDto', () => {
  it('accepts a non-empty user id', () => {
    expect(validateSync(plainToInstance(UserParamDto, { id: 'user-1' }))).toHaveLength(0);
  });

  it('rejects a missing id', () => {
    expect(validateSync(plainToInstance(UserParamDto, {}))).not.toHaveLength(0);
  });

  it.each(['', '   '])('rejects blank id %s', (id) => {
    expect(validateSync(plainToInstance(UserParamDto, { id }))).not.toHaveLength(0);
  });
});
