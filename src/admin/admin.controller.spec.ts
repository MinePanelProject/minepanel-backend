import type { PublicUser } from 'src/users/public-user';
import { AdminController } from './admin.controller';
import type { AdminService } from './admin.service';
import type { ListUsersQueryDto } from './dto/list-users-query.dto';
import type { UpdateUserRoleDto } from './dto/update-user-role.dto';
import type { UpdateUserStatusDto } from './dto/update-user-status.dto';
import type { UserParamDto } from './dto/user-param.dto';

jest.mock('./admin.service', () => ({ AdminService: class AdminService {} }));

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
    'listUsers' | 'updateStatus' | 'updateRole' | 'resetPassword' | 'removeTwoFactor'
  >;
  let controller: AdminController;

  beforeEach(() => {
    adminService = {
      listUsers: jest.fn(),
      updateStatus: jest.fn(),
      updateRole: jest.fn(),
      resetPassword: jest.fn(),
      removeTwoFactor: jest.fn(),
    };
    controller = new AdminController(adminService as AdminService);
  });

  it('delegates user listing with the query DTO', async () => {
    adminService.listUsers = jest.fn().mockResolvedValue([publicUser]);

    await expect(controller.listUsers({ role: 'ADMIN' } as ListUsersQueryDto)).resolves.toEqual([
      publicUser,
    ]);
    expect(adminService.listUsers).toHaveBeenCalledWith({ role: 'ADMIN' });
  });

  it('delegates status updates with the parsed user id and validated body', async () => {
    adminService.updateStatus = jest.fn().mockResolvedValue(publicUser);

    await expect(
      controller.updateStatus(
        { id: 'user-1' } as UserParamDto,
        { status: 'BANNED' } as UpdateUserStatusDto,
      ),
    ).resolves.toEqual(publicUser);
    expect(adminService.updateStatus).toHaveBeenCalledWith('user-1', 'BANNED');
  });

  it('delegates role updates with the parsed user id and validated body', async () => {
    adminService.updateRole = jest.fn().mockResolvedValue(publicUser);

    await expect(
      controller.updateRole({ id: 'user-1' } as UserParamDto, { role: 'MOD' } as UpdateUserRoleDto),
    ).resolves.toEqual(publicUser);
    expect(adminService.updateRole).toHaveBeenCalledWith('user-1', 'MOD');
  });

  it('delegates password resets and returns the temporary password', async () => {
    adminService.resetPassword = jest.fn().mockResolvedValue({ tempPassword: 'temp-pass-value' });

    await expect(controller.resetPassword({ id: 'user-1' } as UserParamDto)).resolves.toEqual({
      tempPassword: 'temp-pass-value',
    });
    expect(adminService.resetPassword).toHaveBeenCalledWith('user-1');
  });

  it('delegates emergency two-factor removal', async () => {
    adminService.removeTwoFactor = jest.fn().mockResolvedValue(publicUser);

    await expect(controller.removeTwoFactor({ id: 'user-1' } as UserParamDto)).resolves.toEqual(
      publicUser,
    );
    expect(adminService.removeTwoFactor).toHaveBeenCalledWith('user-1');
  });
});
