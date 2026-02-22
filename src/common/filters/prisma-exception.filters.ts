import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client-runtime-utils';
import { Response } from 'express';

@Catch(PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    console.log(exception);

    // map Prisma error codes to HTTP status + message
    switch (exception.code) {
      case 'P2002':
        response.status(HttpStatus.CONFLICT).json({ message: 'Resource already exists' });
        break;
      case 'P2025':
        response.status(HttpStatus.NOT_FOUND).json({ message: 'Resource not found' });
        break;
      case 'P2022':
        response.status(HttpStatus.NOT_FOUND).json({ message: 'Column not found' });
        break;
      case 'P1001':
        response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ message: 'Database unreachable' });
        break;
      case 'ECONNREFUSED':
        response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ message: 'Database unavailable' });
        break;
      default:
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Database error' });
    }
  }
}
