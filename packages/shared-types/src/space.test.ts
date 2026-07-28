import { describe, expect, it } from 'vitest';
import { CreateSpaceRequestSchema, PairingCodeResponseSchema, RedeemPairingCodeRequestSchema } from './space';

describe('CreateSpaceRequestSchema', () => {
  it('accepts a valid space name', () => {
    expect(CreateSpaceRequestSchema.safeParse({ name: 'Our Space' }).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(CreateSpaceRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('PairingCodeResponseSchema', () => {
  it('accepts a valid pairing code response', () => {
    const result = PairingCodeResponseSchema.safeParse({
      code: 'ABC12345',
      expiresAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('RedeemPairingCodeRequestSchema', () => {
  it('rejects a code that is not 8 characters', () => {
    expect(RedeemPairingCodeRequestSchema.safeParse({ code: 'short' }).success).toBe(false);
  });
});
