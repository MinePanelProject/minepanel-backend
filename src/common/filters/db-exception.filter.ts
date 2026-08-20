import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

type ExceptionRecord = {
  cause?: ExceptionRecord;
  code?: string;
  message?: string;
};

const isExceptionRecord = (cause: unknown): cause is ExceptionRecord =>
  typeof cause === 'object' && cause !== null;

const isStringCause = (cause: unknown): cause is string => typeof cause === 'string';

@Catch()
export class DbExceptionFilter implements ExceptionFilter {
  catch(cause: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const code = this.getPostgresCode(cause);

    if (!code) {
      if (cause instanceof HttpException) {
        return response.status(cause.getStatus()).json(cause.getResponse());
      }
      return response.status(500).json({ message: 'Internal server error' });
    }

    const message =
      isExceptionRecord(cause) && isStringCause(cause.message) ? cause.message : String(cause);
    Logger.error(message, code, 'DbExceptionFilter');

    switch (code) {
      case '23505': // unique_violation
        response.status(HttpStatus.CONFLICT).json({ message: 'Resource already exists' });
        break;
      case '23503': // foreign_key_violation
        response.status(HttpStatus.BAD_REQUEST).json({ message: 'Related resource not found' });
        break;
      case '42P01': // undefined_table
      case '42703': // undefined_column
        response
          .status(HttpStatus.INTERNAL_SERVER_ERROR)
          .json({ message: 'Database schema error' });
        break;
      default:
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Database error' });
    }
  }

  private getPostgresCode(cause: unknown): string | null {
    if (!isExceptionRecord(cause) || !isExceptionRecord(cause.cause)) {
      return null;
    }

    return isStringCause(cause.cause.code) ? cause.cause.code : null;
  }
}
