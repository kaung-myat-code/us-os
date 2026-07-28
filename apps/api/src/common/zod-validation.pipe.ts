import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export function createZodValidationPipe(schema: ZodSchema): PipeTransform {
  return {
    transform(value: unknown) {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new BadRequestException(
          result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        );
      }
      return result.data;
    },
  };
}
