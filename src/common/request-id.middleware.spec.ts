import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestIdMiddleware } from './request-id.middleware';

type ResponseDouble = Response & { setHeader: jest.Mock; once: jest.Mock };

const makeRequest = (value?: string): Request => {
  // SAFETY: this test double implements the Express Request.get boundary consumed by the middleware.
  const request = Object.create(null) as Request;
  request.get = jest.fn().mockReturnValue(value);
  return request;
};

const makeResponse = (): ResponseDouble => {
  // SAFETY: this test double implements the response methods consumed by the middleware.
  const response = Object.create(null) as ResponseDouble;
  response.setHeader = jest.fn();
  response.once = jest.fn();
  return response;
};

describe('requestIdMiddleware', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => logSpy.mockRestore());

  it.each([
    undefined,
    '',
    'bad id',
    'x'.repeat(129),
  ])('generates a bounded server request ID for invalid input %p', (value) => {
    const request = makeRequest(value);
    const response = makeResponse();
    // SAFETY: this double implements the Express middleware callback boundary used by the unit test.
    const next = jest.fn() as NextFunction;

    requestIdMiddleware(request, response, next);

    const requestId = response.setHeader.mock.calls[0][1];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.once).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  it('accepts a bounded safe client correlation ID and logs it on completion', () => {
    const request = makeRequest('edge-1:abc');
    const response = makeResponse();

    // SAFETY: this double implements the Express middleware callback boundary used by the unit test.
    requestIdMiddleware(request, response, jest.fn() as NextFunction);
    const onFinish = response.once.mock.calls[0][1];
    onFinish();

    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'edge-1:abc');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"requestId":"edge-1:abc"'),
      'HttpRequest',
    );
  });
});
