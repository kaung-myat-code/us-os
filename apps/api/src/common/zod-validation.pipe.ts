import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodSchema } from 'zod';

export function createZodValidationPipe(schema: ZodSchema): PipeTransform {
  return {
    transform(value: unknown) {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new BadRequestException(
          result.error.issues.map((issue: ZodIssue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        );
      }
      return result.data;
    },
  };
}
