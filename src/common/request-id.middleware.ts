import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'X-Request-Id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type RequestWithId = Request & { requestId?: string };

const validRequestId = (value: string | undefined): value is string =>
  value !== undefined && REQUEST_ID_PATTERN.test(value);

export const requestIdMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  // Express normalizes header names and bounds the accepted client value before this check.
  const supplied = request.get(REQUEST_ID_HEADER);
  const requestId = validRequestId(supplied) ? supplied : randomUUID();
  // SAFETY: Express Request.get is the only request field consumed by this middleware.
  const requestWithId = request as RequestWithId;

  requestWithId.requestId = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  response.once('finish', () => {
    Logger.log(
      JSON.stringify({
        event: 'http.request',
        method: request.method,
        path: request.path,
        requestId,
        statusCode: response.statusCode,
      }),
      'HttpRequest',
    );
  });

  next();
};

export { REQUEST_ID_HEADER, type RequestWithId };
