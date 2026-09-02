import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER, type RequestWithId } from 'src/common/request-id.middleware';

type ExceptionRecord = {
  cause?: unknown;
  code?: unknown;
  error?: unknown;
  message?: unknown;
  details?: unknown;
  resource?: unknown;
  availableMb?: unknown;
  requiredMb?: unknown;
  totalMb?: unknown;
};

type ErrorDetails = {
  messages?: string[];
  resource?: string | number;
  availableMb?: number;
  requiredMb?: number;
  totalMb?: number;
};

type ApiError = {
  statusCode: number;
  error: string;
  message: string;
  details: ErrorDetails;
  requestId: string;
};
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

const isExceptionRecord = (value: unknown): value is ExceptionRecord =>
  typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

const isMachineCode = (value: unknown): value is string =>
  isString(value) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value);

const statusCodeFor = (statusCode: number): string => {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE_ENTITY';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_ERROR';
  }
};

const defaultMessageFor = (statusCode: number): string =>
  statusCode >= 500 ? 'Internal server error' : 'Request failed';

@Catch()
export class DbExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DbExceptionFilter.name);

  catch(cause: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = this.requestId(request, response);
    const error = this.normalize(cause, requestId);

    response.status(error.statusCode).json(error);
    this.logger.error(
      JSON.stringify({
        event: 'http.error',
        error: error.error,
        method: request.method,
        path: request.path,
        requestId,
        statusCode: error.statusCode,
      }),
    );
  }

  private normalize(cause: unknown, requestId: string): ApiError {
    const postgresCode = this.getPostgresCode(cause);
    if (postgresCode) {
      return this.normalizePostgres(postgresCode, requestId);
    }

    if (!(cause instanceof HttpException)) {
      return this.error(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error', {}, requestId);
    }

    const statusCode = cause.getStatus();
    const raw = cause.getResponse();
    const record = isExceptionRecord(raw) ? raw : undefined;
    const rawMessage = record?.message ?? raw;
    const messages = Array.isArray(rawMessage)
      ? rawMessage.filter(isString).slice(0, 50)
      : undefined;
    const requestedCode = record?.error;
    const error =
      messages !== undefined
        ? 'ValidationError'
        : isMachineCode(requestedCode) &&
            !['Bad Request', 'Unauthorized', 'Forbidden', 'Not Found', 'Conflict'].includes(
              requestedCode,
            )
          ? requestedCode
          : statusCodeFor(statusCode);
    const message =
      messages !== undefined
        ? 'Validation failed'
        : isString(rawMessage)
          ? rawMessage
          : defaultMessageFor(statusCode);
    const details =
      messages !== undefined
        ? { messages }
        : error === 'InsufficientResources' && isExceptionRecord(record?.details)
          ? this.resourceDetails(record.details)
          : {};

    return this.error(statusCode, message, details, requestId, error);
  }

  private normalizePostgres(postgresCode: string, requestId: string): ApiError {
    switch (postgresCode) {
      case '23505':
        return this.error(
          HttpStatus.CONFLICT,
          'Resource already exists',
          {},
          requestId,
          'CONFLICT',
        );
      case '23503':
        return this.error(
          HttpStatus.BAD_REQUEST,
          'Related resource not found',
          {},
          requestId,
          'BAD_REQUEST',
        );
      case '42P01':
      case '42703':
        return this.error(HttpStatus.INTERNAL_SERVER_ERROR, 'Database schema error', {}, requestId);
      default:
        return this.error(HttpStatus.INTERNAL_SERVER_ERROR, 'Database error', {}, requestId);
    }
  }

  private resourceDetails(details: ExceptionRecord): ErrorDetails {
    const result: ErrorDetails = {};
    if (isString(details.resource)) result.resource = details.resource;
    for (const key of ['availableMb', 'requiredMb', 'totalMb'] as const) {
      const value = details[key];
      if (isFiniteNumber(value)) result[key] = value;
    }
    return result;
  }

  private error(
    statusCode: number,
    message: string,
    details: ErrorDetails,
    requestId: string,
    error = statusCodeFor(statusCode),
  ): ApiError {
    return { statusCode, error, message, details, requestId };
  }

  private requestId(request: Request, response: Response): string {
    // SAFETY: requestIdMiddleware attaches this field before the global filter handles requests.
    const requestWithId = request as RequestWithId;
    const requestId = requestWithId.requestId ?? randomUUID();
    response.setHeader(REQUEST_ID_HEADER, requestId);
    return requestId;
  }

  private getPostgresCode(cause: unknown): string | null {
    if (!isExceptionRecord(cause) || !isExceptionRecord(cause.cause)) return null;
    return isString(cause.cause.code) ? cause.cause.code : null;
  }
}
