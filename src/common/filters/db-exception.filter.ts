import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

// postgres.js error shape
interface PostgresError extends Error {
  code: string;
}

@Catch()
export class DbExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Only handle postgres.js errors (they have a numeric-ish code like '23505')
    if (!this.isPostgresError(exception)) return;

    Logger.error(exception.message, exception.code, 'DbExceptionFilter');

    switch (exception.code) {
      case '23505': // unique_violation
        response.status(HttpStatus.CONFLICT).json({ message: 'Resource already exists' });
        break;
      case '23503': // foreign_key_violation
        response.status(HttpStatus.BAD_REQUEST).json({ message: 'Related resource not found' });
        break;
      case '42P01': // undefined_table
      case '42703': // undefined_column
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Database schema error' });
        break;
      default:
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Database error' });
    }
  }

  private isPostgresError(exception: unknown): exception is PostgresError {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      typeof (exception as PostgresError).code === 'string'
    );
  }
}
