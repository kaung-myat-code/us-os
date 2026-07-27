import { describe, expect, it } from 'vitest';
import { HealthStatusSchema } from './health';

describe('HealthStatusSchema', () => {
  it('accepts a valid health status payload', () => {
    const result = HealthStatusSchema.safeParse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });

    expect(result.success).toBe(true);
  });

  it('rejects a payload with an invalid status value', () => {
    const result = HealthStatusSchema.safeParse({
      status: 'unknown',
      timestamp: new Date().toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing the timestamp', () => {
    const result = HealthStatusSchema.safeParse({ status: 'ok' });

    expect(result.success).toBe(false);
  });
});
