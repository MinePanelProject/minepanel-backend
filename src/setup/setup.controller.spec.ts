import { Test, type TestingModule } from '@nestjs/testing';
import { SetupController } from './setup.controller';
import { SetupService, type SetupStatus } from './setup.service';

describe('SetupController', () => {
  let controller: SetupController;
  let setupService: {
    getSetupState: jest.Mock;
    initAdminRegister: jest.Mock;
  };

  beforeEach(async () => {
    setupService = {
      getSetupState: jest.fn(),
      initAdminRegister: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SetupController],
      providers: [{ provide: SetupService, useValue: setupService }],
    }).compile();

    controller = module.get<SetupController>(SetupController);
  });

  it('returns the setup state from the service', async () => {
    const state: SetupStatus = { initialAdminCreated: false, nextStep: 'register_admin' };
    setupService.getSetupState.mockResolvedValue(state);

    await expect(controller.getStatus()).resolves.toBe(state);
  });

  it('delegates first-admin registration and reports the created admin', async () => {
    const dto = { email: 'admin@example.com', username: 'admin', password: 's3cret' };
    setupService.initAdminRegister.mockResolvedValue(true);

    await expect(controller.init(dto)).resolves.toEqual({
      message: 'Admin admin created successfully',
    });
    expect(setupService.initAdminRegister).toHaveBeenCalledWith(dto);
  });
});
