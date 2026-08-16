import { ConflictException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { DRIZZLE } from 'src/db/db.module';
import { users } from 'src/db/schema';
import { SetupService, type SetupStatus } from './setup.service';

const CONFIGURED_TOKEN = 'configured-setup-token';

type InsertCall = { table: unknown; value: unknown };

describe('SetupService', () => {
  let service: SetupService;
  let stateRow: { initialAdminCreated: boolean };
  let txStateRow: { initialAdminCreated: boolean };
  let rootInsert: jest.Mock;
  let rootSelect: jest.Mock;
  let transaction: jest.Mock;
  let txInsertCalls: InsertCall[];
  let txFlagSets: Record<string, unknown>[];
  let txUpdateFails: boolean;
  let configGet: jest.Mock;
  let warnSpy: jest.SpyInstance;

  const rowsResult = (rows: unknown[]) => {
    const result = Promise.resolve(rows) as Promise<unknown[]> & { limit: jest.Mock };
    result.limit = jest.fn().mockResolvedValue(rows);
    return result;
  };

  beforeEach(async () => {
    stateRow = { initialAdminCreated: false };
    txStateRow = { initialAdminCreated: false };
    txInsertCalls = [];
    txFlagSets = [];
    txUpdateFails = false;

    rootInsert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      })),
    }));
    rootSelect = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => rowsResult([stateRow])),
      })),
    }));

    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((value: unknown) => {
          txInsertCalls.push({ table, value });
          const pending = Promise.resolve() as Promise<void> & {
            onConflictDoNothing: jest.Mock;
          };
          pending.onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
          return pending;
        }),
      })),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => rowsResult([txStateRow])),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn((value: Record<string, unknown>) => {
          txFlagSets.push(value);
          return {
            where: txUpdateFails
              ? jest.fn().mockRejectedValue(new Error('flag update failed'))
              : jest.fn().mockResolvedValue(undefined),
          };
        }),
      })),
    };
    transaction = jest.fn(async (callback: (handle: unknown) => Promise<unknown>) => callback(tx));

    configGet = jest.fn().mockReturnValue(CONFIGURED_TOKEN);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SetupService,
        { provide: DRIZZLE, useValue: { insert: rootInsert, select: rootSelect, transaction } },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<SetupService>(SetupService);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const dto = () => ({
    email: 'admin@example.com',
    username: 'admin',
    password: 's3cret-password',
  });

  it('upserts the singleton row and reports register_admin as next step', async () => {
    const expected: SetupStatus = { initialAdminCreated: false, nextStep: 'register_admin' };

    await expect(service.getSetupState()).resolves.toEqual(expected);
    expect(rootInsert).toHaveBeenCalled();
  });

  it('reports complete when the first admin is already created', async () => {
    stateRow.initialAdminCreated = true;

    const expected: SetupStatus = { initialAdminCreated: true, nextStep: 'complete' };

    await expect(service.getSetupState()).resolves.toEqual(expected);
  });

  it('registers the first admin inside the transaction and marks setup complete', async () => {
    await expect(service.initAdminRegister(dto(), CONFIGURED_TOKEN)).resolves.toBe(true);

    const userInserts = txInsertCalls.filter((call) => call.table === users);
    expect(userInserts).toHaveLength(1);
    const inserted = userInserts[0].value as {
      email: string;
      username: string;
      passwordHash: string;
      status: string;
      role: string;
    };
    expect(inserted).toMatchObject({
      email: 'admin@example.com',
      username: 'admin',
      status: 'ACTIVE',
      role: 'ADMIN',
    });
    await expect(bcrypt.compare('s3cret-password', inserted.passwordHash)).resolves.toBe(true);
    expect(txFlagSets).toEqual([{ initialAdminCreated: true }]);
    // every write went through the transaction handle; the root db only served
    // the token-resolution state read
    expect(rootInsert).not.toHaveBeenCalled();
  });

  it('rejects a missing setup token before touching the database transaction', async () => {
    await expect(service.initAdminRegister(dto(), undefined)).rejects.toThrow(
      new UnauthorizedException({ error: 'SetupTokenInvalid' }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a wrong setup token with the same response as a missing one', async () => {
    const missing = await service.initAdminRegister(dto(), undefined).catch((error) => error);
    const wrong = await service.initAdminRegister(dto(), 'wrong-token').catch((error) => error);

    expect(missing).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect((wrong as UnauthorizedException).getResponse()).toEqual(
      (missing as UnauthorizedException).getResponse(),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects registration with 409 when the transaction re-read finds setup complete', async () => {
    txStateRow.initialAdminCreated = true;

    await expect(service.initAdminRegister(dto(), CONFIGURED_TOKEN)).rejects.toThrow(
      new ConflictException({ error: 'SetupAlreadyComplete' }),
    );
    expect(txInsertCalls.filter((call) => call.table === users)).toHaveLength(0);
    expect(txFlagSets).toHaveLength(0);
  });

  it('propagates a flag update failure after inserting through the transaction handle', async () => {
    txUpdateFails = true;

    await expect(service.initAdminRegister(dto(), CONFIGURED_TOKEN)).rejects.toThrow(
      'flag update failed',
    );
    expect(txInsertCalls.filter((call) => call.table === users)).toHaveLength(1);
    expect(rootInsert).not.toHaveBeenCalled();
  });

  it('rejects missing and wrong tokens as invalid after a completed fallback-mode restart', async () => {
    configGet.mockReturnValue(undefined);
    stateRow.initialAdminCreated = true;

    const missing = await service.initAdminRegister(dto(), undefined).catch((error) => error);
    const wrong = await service.initAdminRegister(dto(), 'anything').catch((error) => error);

    expect(missing).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect((wrong as UnauthorizedException).getResponse()).toEqual(
      (missing as UnauthorizedException).getResponse(),
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('generates a base64url bootstrap token under the startup lock while setup is incomplete', async () => {
    configGet.mockReturnValue(undefined);

    await service.onModuleInit();
    await service.onModuleInit();

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0] as string;
    const token = /process: ([A-Za-z0-9_-]+) —/.exec(logged)?.[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    await expect(service.initAdminRegister(dto(), token)).resolves.toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
  it('does not generate a fallback token when the locked startup re-read is complete', async () => {
    configGet.mockReturnValue(undefined);
    txStateRow.initialAdminCreated = true;

    await service.onModuleInit();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never logs a configured token', async () => {
    await service.onModuleInit();
    await service.initAdminRegister(dto(), CONFIGURED_TOKEN);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
