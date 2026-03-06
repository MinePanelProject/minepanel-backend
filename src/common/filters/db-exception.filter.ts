import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class DbExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const code = this.getPostgresCode(exception);

    // Only handle postgres.js errors (they have a numeric-ish code like '23505'), the rest gets filtered and returned based on the status
    if (!code) {
      if (exception instanceof HttpException) {
        return response.status(exception.getStatus()).json(exception.getResponse());
      }
      return response.status(500).json({ message: 'Internal server error' });
    }

    Logger.error((exception as Error).message, code, 'DbExceptionFilter');

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

  private getPostgresCode(exception: unknown): string | null {
    if (typeof exception === 'object' && exception != null && 'cause' in exception) {
      if (
        typeof exception.cause === 'object' &&
        exception.cause != null &&
        'code' in exception.cause
      ) {
        return typeof exception.cause.code === 'string' ? exception.cause.code : null;
      }
    }
    return null;
  }
}
