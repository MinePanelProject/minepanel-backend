import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServerDto } from './create-server.dto';

const validCreatePayload = {
  name: 'Survival',
  provider: 'PAPER',
  version: '1.21.1',
  port: 25565,
};

describe('CreateServerDto', () => {
  it('accepts the required creation fields and optional lifecycle settings', async () => {
    const dto = plainToInstance(CreateServerDto, {
      ...validCreatePayload,
      maxPlayers: 40,
      difficulty: 'HARD',
      gamemode: 'ADVENTURE',
      pvp: false,
      memoryLimitMb: 4096,
      motd: 'A friendly server',
      levelSeed: 'seed-1',
      onlineMode: false,
      viewDistance: 16,
      allowFlight: true,
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('accepts omitted optional fields so the service can apply defaults', async () => {
    const dto = plainToInstance(CreateServerDto, validCreatePayload);

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto).not.toHaveProperty('ownerId');
  });

  it('rejects ownerId as a client-controlled non-whitelisted property', async () => {
    const dto = plainToInstance(CreateServerDto, {
      ...validCreatePayload,
      ownerId: 'forged-owner',
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: 'ownerId',
          constraints: expect.objectContaining({ whitelistValidation: expect.any(String) }),
        }),
      ]),
    );
  });

  it.each([
    ['provider', 'INVALID'],
    ['version', 'latest'],
    ['port', 25564],
    ['maxPlayers', 0],
    ['memoryLimitMb', 511],
    ['viewDistance', 1],
  ])('rejects an invalid %s value', async (field, value) => {
    const dto = plainToInstance(CreateServerDto, { ...validCreatePayload, [field]: value });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });

  it('trims and sanitizes user-facing text fields', async () => {
    const dto = plainToInstance(CreateServerDto, {
      ...validCreatePayload,
      name: '  <Survival>  ',
      motd: '  Welcome <players>  ',
      version: ' 1.21.1 ',
    });

    expect(dto.name).toBe('Survival');
    expect(dto.motd).toBe('Welcome players');
    expect(dto.version).toBe('1.21.1');
    await expect(validate(dto)).resolves.toEqual([]);
  });
});
