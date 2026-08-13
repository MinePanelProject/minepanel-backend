import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ServerUserParamDto } from './server-user-param.dto';

describe('ServerUserParamDto', () => {
  it('accepts a server id and a valid UUID user id', () => {
    const dto = plainToInstance(ServerUserParamDto, {
      id: 'server-1',
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects a missing server id', () => {
    const dto = plainToInstance(ServerUserParamDto, {
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('rejects an empty server id', () => {
    const dto = plainToInstance(ServerUserParamDto, {
      id: '',
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('rejects a non-UUID user id', () => {
    const dto = plainToInstance(ServerUserParamDto, {
      id: 'server-1',
      userId: 'not-a-uuid',
    });

    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('rejects a missing user id', () => {
    const dto = plainToInstance(ServerUserParamDto, { id: 'server-1' });

    expect(validateSync(dto)).not.toHaveLength(0);
  });
});
