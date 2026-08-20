import type { PublicUser } from 'src/users/public-user';
import { AdminController } from './admin.controller';
import type { AdminService } from './admin.service';
import type { ListUsersQueryDto } from './dto/list-users-query.dto';
import type { UpdateUserRoleDto } from './dto/update-user-role.dto';
import type { UpdateUserStatusDto } from './dto/update-user-status.dto';
import type { UserParamDto } from './dto/user-param.dto';

const publicPermission = {
  id: 'perm-1',
  userId: 'user-1',
  permission: 'SERVER_LIFECYCLE' as const,
  serverId: null,
  createdAt: new Date(),
};

const publicUser: PublicUser = {
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  role: 'USER',
  status: 'ACTIVE',
  totpEnabled: false,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AdminController', () => {
  let adminService: Pick<
    AdminService,
    | 'listUsers'
    | 'updateStatus'
    | 'updateRole'
    | 'resetPassword'
    | 'removeTwoFactor'
    | 'listModPermissions'
    | 'grantModPermission'
    | 'revokeModPermission'
  >;
  let controller: AdminController;

  beforeEach(() => {
    adminService = {
      listUsers: jest.fn(),
      updateStatus: jest.fn(),
      updateRole: jest.fn(),
      resetPassword: jest.fn(),
      removeTwoFactor: jest.fn(),
      listModPermissions: jest.fn(),
      grantModPermission: jest.fn(),
      revokeModPermission: jest.fn(),
    };
    // SAFETY: NestJS injection consumes the AdminService collaborator; this double supplies
    // every method exercised by AdminController in these tests.
    controller = new AdminController(adminService as AdminService);
  });

  it('delegates user listing with the query DTO', async () => {
    adminService.listUsers = jest.fn().mockResolvedValue([publicUser]);

    // SAFETY: NestJS query validation is the producer; the ListUsersQueryDto contract invariant
    // supplies the exact role field consumed by AdminController.listUsers.
    const query = { role: 'ADMIN' } as ListUsersQueryDto;
    await expect(controller.listUsers(query)).resolves.toEqual([publicUser]);
    expect(adminService.listUsers).toHaveBeenCalledWith({ role: 'ADMIN' });
  });

  it('delegates status updates with the parsed user id and validated body', async () => {
    adminService.updateStatus = jest.fn().mockResolvedValue(publicUser);
    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id field consumed by AdminController.updateStatus.
    const params = { id: 'user-1' } as UserParamDto;
    // SAFETY: NestJS body validation is the producer; the UpdateUserStatusDto contract invariant
    // supplies the exact status field consumed by AdminController.updateStatus.
    const body = { status: 'BANNED' } as UpdateUserStatusDto;
    await expect(controller.updateStatus(params, body)).resolves.toEqual(publicUser);
    expect(adminService.updateStatus).toHaveBeenCalledWith('user-1', 'BANNED');
  });

  it('delegates role updates with the parsed user id and validated body', async () => {
    adminService.updateRole = jest.fn().mockResolvedValue(publicUser);
    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id field consumed by AdminController.updateRole.
    const params = { id: 'user-1' } as UserParamDto;
    // SAFETY: NestJS body validation is the producer; the UpdateUserRoleDto contract invariant
    // supplies the exact role field consumed by AdminController.updateRole.
    const body = { role: 'MOD' } as UpdateUserRoleDto;
    await expect(controller.updateRole(params, body)).resolves.toEqual(publicUser);
    expect(adminService.updateRole).toHaveBeenCalledWith('user-1', 'MOD');
  });

  it('delegates password resets and returns the temporary password', async () => {
    adminService.resetPassword = jest.fn().mockResolvedValue({ tempPassword: 'temp-pass-value' });
    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id field consumed by AdminController.resetPassword.
    const params = { id: 'user-1' } as UserParamDto;
    await expect(controller.resetPassword(params)).resolves.toEqual({
      tempPassword: 'temp-pass-value',
    });
    expect(adminService.resetPassword).toHaveBeenCalledWith('user-1');
  });

  it('delegates emergency two-factor removal', async () => {
    adminService.removeTwoFactor = jest.fn().mockResolvedValue(publicUser);
    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id field consumed by AdminController.removeTwoFactor.
    const params = { id: 'user-1' } as UserParamDto;
    await expect(controller.removeTwoFactor(params)).resolves.toEqual(publicUser);
    expect(adminService.removeTwoFactor).toHaveBeenCalledWith('user-1');
  });

  it('delegates permission listing with the user id', async () => {
    adminService.listModPermissions = jest.fn().mockResolvedValue([publicPermission]);
    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id field consumed by AdminController.listPermissions.
    const params = { id: 'user-1' } as UserParamDto;
    await expect(controller.listPermissions(params)).resolves.toEqual([publicPermission]);
    expect(adminService.listModPermissions).toHaveBeenCalledWith('user-1');
  });

  it('delegates permission grants with the user id and DTO', async () => {
    adminService.grantModPermission = jest.fn().mockResolvedValue(publicPermission);
    const dto = { permission: 'SERVER_LIFECYCLE' as const, serverId: 'server-1' };
    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id field consumed by AdminController.grantPermission.
    const params = { id: 'user-1' } as UserParamDto;
    await expect(controller.grantPermission(params, dto)).resolves.toEqual(publicPermission);
    expect(adminService.grantModPermission).toHaveBeenCalledWith('user-1', dto);
  });

  it('delegates permission revocation with the user id and permission grant id', async () => {
    adminService.revokeModPermission = jest.fn().mockResolvedValue(undefined);

    // SAFETY: NestJS route validation is the producer; the UserParamDto contract invariant
    // supplies the exact id and permId fields consumed by AdminController.revokePermission.
    const params = { id: 'user-1', permId: 'perm-1' } as never;
    await expect(controller.revokePermission(params)).resolves.toBeUndefined();
    expect(adminService.revokeModPermission).toHaveBeenCalledWith('user-1', 'perm-1');
  });
});
