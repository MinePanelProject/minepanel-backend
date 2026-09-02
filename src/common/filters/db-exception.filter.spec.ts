import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DbExceptionFilter } from './db-exception.filter';

type HttpTestContext = {
  request: { method: string; path: string; requestId?: string };
  response: { setHeader: jest.Mock; status: jest.Mock; json: jest.Mock };
  host: ArgumentsHost;
};

const makeContext = (requestId?: string): HttpTestContext => {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  const request = { method: 'POST', path: '/api/test', requestId };
  const http = { getResponse: () => response, getRequest: () => request };
  // SAFETY: this test host implements the exact switchToHttp methods consumed by the filter.
  const host = { switchToHttp: () => http } as ArgumentsHost;
  return { request, response, host };
};

describe('DbExceptionFilter', () => {
  let filter: DbExceptionFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new DbExceptionFilter();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('normalizes validation errors and preserves the request ID', () => {
    const context = makeContext('client-request-1');

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['email must be an email', 'password is invalid'],
      }),
      context.host,
    );

    expect(context.response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-request-1');
    expect(context.response.status).toHaveBeenCalledWith(400);
    expect(context.response.json).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'ValidationError',
      message: 'Validation failed',
      details: { messages: ['email must be an email', 'password is invalid'] },
      requestId: 'client-request-1',
    });
  });

  it('preserves domain machine codes while normalizing the envelope', () => {
    const context = makeContext('request-2');

    filter.catch(new ForbiddenException({ error: 'AccountPending' }), context.host);

    expect(context.response.json).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'AccountPending',
      message: 'Request failed',
      details: {},
      requestId: 'request-2',
    });
  });

  it('maps database failures without exposing database details', () => {
    const context = makeContext();
    const databaseError = new Error('password=secret host=/private/db');
    const wrapper = Object.assign(new Error('query failed'), { cause: databaseError });
    Object.assign(databaseError, { code: '23505' });

    filter.catch(wrapper, context.host);

    const body = context.response.json.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'CONFLICT',
      message: 'Resource already exists',
      details: {},
    });
    expect(body.message).not.toContain('secret');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('returns a safe generic envelope for unexpected exceptions and logs correlation data', () => {
    const context = makeContext('request-3');

    filter.catch(new Error('token=secret /private/path'), context.host);

    expect(context.response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(context.response.json).toHaveBeenCalledWith({
      statusCode: 500,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      details: {},
      requestId: 'request-3',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"requestId":"request-3"'));
  });

  it('normalizes rate-limit and resource details without changing their status', () => {
    const context = makeContext('request-4');

    filter.catch(
      new HttpException(
        {
          statusCode: 422,
          error: 'InsufficientResources',
          message: 'Insufficient memory',
          details: { resource: 'memory', availableMb: 1, requiredMb: 2, totalMb: 3 },
        },
        422,
      ),
      context.host,
    );

    expect(context.response.json).toHaveBeenCalledWith({
      statusCode: 422,
      error: 'InsufficientResources',
      message: 'Insufficient memory',
      details: { resource: 'memory', availableMb: 1, requiredMb: 2, totalMb: 3 },
      requestId: 'request-4',
    });
  });
});
