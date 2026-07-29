import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { createZodValidationPipe } from './zod-validation.pipe';

describe('createZodValidationPipe', () => {
  const schema = z.object({ email: z.string().email() });
  const pipe = createZodValidationPipe(schema);

  it('returns the parsed value for valid input', () => {
    const result = pipe.transform({ email: 'a@example.com' }, {} as never);
    expect(result).toEqual({ email: 'a@example.com' });
  });

  it('throws BadRequestException with joined issue messages for invalid input', () => {
    expect(() => pipe.transform({ email: 'not-an-email' }, {} as never)).toThrow(
      BadRequestException,
    );
  });
});
