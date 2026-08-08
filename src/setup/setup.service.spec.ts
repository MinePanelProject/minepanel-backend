import { ForbiddenException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { DRIZZLE } from 'src/db/db.module';
import { UsersService } from 'src/users/users.service';
import { SetupService, type SetupStatus } from './setup.service';

describe('SetupService', () => {
  let service: SetupService;
  let stateRow: { initialAdminCreated: boolean };
  let insert: jest.Mock;
  let select: jest.Mock;
  let update: jest.Mock;
  let createUser: jest.Mock;

  beforeEach(async () => {
    stateRow = { initialAdminCreated: false };
    insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      })),
    }));
    select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue([stateRow]),
        })),
      })),
    }));
    update = jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn().mockResolvedValue(undefined),
      })),
    }));
    createUser = jest.fn().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SetupService,
        { provide: DRIZZLE, useValue: { insert, select, update } },
        { provide: UsersService, useValue: { createUser } },
      ],
    }).compile();

    service = module.get<SetupService>(SetupService);
  });

  it('upserts the singleton row and reports register_admin as next step', async () => {
    const expected: SetupStatus = { initialAdminCreated: false, nextStep: 'register_admin' };

    await expect(service.getSetupState()).resolves.toEqual(expected);
    expect(insert).toHaveBeenCalled();
  });

  it('reports complete when the first admin is already created', async () => {
    stateRow = { initialAdminCreated: true };

    const expected: SetupStatus = { initialAdminCreated: true, nextStep: 'complete' };

    await expect(service.getSetupState()).resolves.toEqual(expected);
  });

  it('registers the first admin with a hashed password and marks setup complete', async () => {
    const dto = { email: 'admin@example.com', username: 'admin', password: 's3cret-password' };

    await expect(service.initAdminRegister(dto)).resolves.toBe(true);

    expect(createUser).toHaveBeenCalledWith(
      dto.email,
      dto.username,
      expect.any(String),
      'ACTIVE',
      'ADMIN',
    );
    const passwordHash = createUser.mock.calls[0][2] as string;
    await expect(bcrypt.compare(dto.password, passwordHash)).resolves.toBe(true);
    expect(update).toHaveBeenCalled();
  });

  it('rejects registering another admin once one exists', async () => {
    stateRow = { initialAdminCreated: true };
    const dto = { email: 'admin@example.com', username: 'admin', password: 's3cret-password' };

    await expect(service.initAdminRegister(dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(createUser).not.toHaveBeenCalled();
  });
});
