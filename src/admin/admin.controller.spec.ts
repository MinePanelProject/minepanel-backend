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
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    controller = new AdminController(adminService as AdminService);
  });

  it('delegates user listing with the query DTO', async () => {
    adminService.listUsers = jest.fn().mockResolvedValue([publicUser]);

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    await expect(controller.listUsers({ role: 'ADMIN' } as ListUsersQueryDto)).resolves.toEqual([
      publicUser,
    ]);
    expect(adminService.listUsers).toHaveBeenCalledWith({ role: 'ADMIN' });
  });

  it('delegates status updates with the parsed user id and validated body', async () => {
    adminService.updateStatus = jest.fn().mockResolvedValue(publicUser);

    await expect(
      controller.updateStatus(
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
        { id: 'user-1' } as UserParamDto,
        // SAFETY: the DTO literal contains every field read by updateStatus.
        { status: 'BANNED' } as UpdateUserStatusDto,
      ),
    ).resolves.toEqual(publicUser);
    expect(adminService.updateStatus).toHaveBeenCalledWith('user-1', 'BANNED');
  });

  it('delegates role updates with the parsed user id and validated body', async () => {
    adminService.updateRole = jest.fn().mockResolvedValue(publicUser);

    await expect(
      // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      controller.updateRole({ id: 'user-1' } as UserParamDto, { role: 'MOD' } as UpdateUserRoleDto),
    ).resolves.toEqual(publicUser);
    expect(adminService.updateRole).toHaveBeenCalledWith('user-1', 'MOD');
  });

  it('delegates password resets and returns the temporary password', async () => {
    adminService.resetPassword = jest.fn().mockResolvedValue({ tempPassword: 'temp-pass-value' });

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    await expect(controller.resetPassword({ id: 'user-1' } as UserParamDto)).resolves.toEqual({
      tempPassword: 'temp-pass-value',
    });
    expect(adminService.resetPassword).toHaveBeenCalledWith('user-1');
  });

  it('delegates emergency two-factor removal', async () => {
    adminService.removeTwoFactor = jest.fn().mockResolvedValue(publicUser);

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    await expect(controller.removeTwoFactor({ id: 'user-1' } as UserParamDto)).resolves.toEqual(
      publicUser,
    );
    expect(adminService.removeTwoFactor).toHaveBeenCalledWith('user-1');
  });

  it('delegates permission listing with the user id', async () => {
    adminService.listModPermissions = jest.fn().mockResolvedValue([publicPermission]);

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    await expect(controller.listPermissions({ id: 'user-1' } as UserParamDto)).resolves.toEqual([
      publicPermission,
    ]);
    expect(adminService.listModPermissions).toHaveBeenCalledWith('user-1');
  });

  it('delegates permission grants with the user id and DTO', async () => {
    adminService.grantModPermission = jest.fn().mockResolvedValue(publicPermission);
    const dto = { permission: 'SERVER_LIFECYCLE' as const, serverId: 'server-1' };

    await expect(
      // SAFETY: This fixture supplies the only route parameter read by grantPermission.
      controller.grantPermission({ id: 'user-1' } as UserParamDto, dto),
    ).resolves.toEqual(publicPermission);
    expect(adminService.grantModPermission).toHaveBeenCalledWith('user-1', dto);
  });

  it('delegates permission revocation with the user id and permission grant id', async () => {
    adminService.revokeModPermission = jest.fn().mockResolvedValue(undefined);

    await expect(
      // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      controller.revokePermission({ id: 'user-1', permId: 'perm-1' } as never),
    ).resolves.toBeUndefined();
    expect(adminService.revokeModPermission).toHaveBeenCalledWith('user-1', 'perm-1');
  });
});
