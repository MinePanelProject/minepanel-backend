import { Test, type TestingModule } from '@nestjs/testing';
import { DRIZZLE } from 'src/db/db.module';
import type { User } from 'src/db/schema';
import { UsersService } from './users.service';

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
  role: 'USER',
  status: 'ACTIVE',
  totpSecret: null,
  totpEnabled: false,
  totpBackupCodes: null,
  tempPasswordHash: null,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('UsersService', () => {
  let service: UsersService;
  let rows: User[];
  let select: jest.Mock;

  beforeEach(async () => {
    rows = [];
    select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockImplementation(async () => rows.slice(0, 1)),
        })),
      })),
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: DRIZZLE, useValue: { select } }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('finds a user by id', async () => {
    const user = makeUser();
    rows = [user];

    await expect(service.findById('user-1')).resolves.toEqual(user);
  });

  it('returns null when no user matches the id', async () => {
    await expect(service.findById('missing')).resolves.toBeNull();
  });

  it('finds a user by email or username', async () => {
    const user = makeUser();
    rows = [user];

    await expect(service.findByIdentifier('player')).resolves.toEqual(user);
    await expect(service.findByIdentifier('user@example.com')).resolves.toEqual(user);
  });
});
