import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Unavailable } from './contracts.js';

export class ApiError extends HttpException {
  readonly details: Unavailable;

  constructor(status: number, code: string, reason: string) {
    const details: Unavailable = { available: false, code, reason };
    super(details, status);
    this.message = reason;
    this.details = details;
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    // Express JSON parser failures occur before controller validation.
    let failure = new ApiError(500, 'internal_error', 'The operator request failed.');
    if (error instanceof ApiError) {
      failure = error;
    } else if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
      failure = new ApiError(413, 'invalid_input', 'Request body exceeded 16 KiB.');
    } else if (error instanceof HttpException && error.getStatus() < 500) {
      failure = new ApiError(error.getStatus(), 'invalid_input', error.message);
    }

    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(failure.getStatus()).json(failure.details);
  }
}
