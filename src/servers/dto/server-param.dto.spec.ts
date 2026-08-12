import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ServerParamDto } from './server-param.dto';

describe('ServerParamDto', () => {
  it('accepts a non-empty string id', async () => {
    const dto = plainToInstance(ServerParamDto, { id: 'server-1' });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each(['', null, undefined, 123, false])('rejects an invalid id %p', async (id) => {
    const dto = plainToInstance(ServerParamDto, { id });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });
});
