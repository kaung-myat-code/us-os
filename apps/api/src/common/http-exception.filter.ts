import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    // Nest's default exception body is `{ message, error, statusCode }` (or
    // just a string). CLAUDE.md requires RFC 7807 Problem Details instead, so
    // this filter is the single place that reshapes every thrown HttpException
    // — controllers/services just throw plain Nest exceptions with a message.
    const detail =
      typeof body === 'string'
        ? body
        : Array.isArray((body as { message?: unknown }).message)
          ? (body as { message: string[] }).message.join('; ')
          : ((body as { message?: string }).message ?? exception.message);

    res.status(status).json({
      type: 'about:blank',
      title: exception.name.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
      status,
      detail,
    });
  }
}
