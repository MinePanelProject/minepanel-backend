import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListServersQueryDto } from './list-servers-query.dto';

describe('ListServersQueryDto', () => {
  it('defaults to twenty rows from offset zero', async () => {
    const dto = plainToInstance(ListServersQueryDto, {});

    expect(dto.limit).toBe(20);
    expect(dto.offset).toBe(0);
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('transforms numeric query strings before validation', async () => {
    const dto = plainToInstance(ListServersQueryDto, { limit: '7', offset: '14' });

    expect(dto).toEqual(expect.objectContaining({ limit: 7, offset: 14 }));
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each([0, 101, 1.5, 'not-a-number'])('rejects an invalid limit %p', async (limit) => {
    const dto = plainToInstance(ListServersQueryDto, { limit });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });

  it.each([-1, 1.5, 'not-a-number'])('rejects an invalid offset %p', async (offset) => {
    const dto = plainToInstance(ListServersQueryDto, { offset });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });

  it('accepts the inclusive pagination bounds', async () => {
    const dto = plainToInstance(ListServersQueryDto, { limit: 1, offset: 0 });
    const maximum = plainToInstance(ListServersQueryDto, { limit: 100, offset: 999 });

    await expect(validate(dto)).resolves.toEqual([]);
    await expect(validate(maximum)).resolves.toEqual([]);
  });
});
