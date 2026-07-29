import { ArgumentsHost, ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('converts an HttpException into an RFC 7807 Problem Details body', () => {
    const filter = new HttpExceptionFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new ConflictException("You're already part of a Space"), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: "You're already part of a Space",
    });
  });
});
