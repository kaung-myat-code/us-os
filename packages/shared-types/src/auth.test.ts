import { describe, expect, it } from 'vitest';
import { AuthMeResponseSchema, LoginRequestSchema, RegisterRequestSchema } from './auth';

describe('RegisterRequestSchema', () => {
  it('accepts a valid registration payload without a pairing code', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'a@example.com',
      password: 'supersecret',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid registration payload with an 8-char pairing code', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'a@example.com',
      password: 'supersecret',
      pairingCode: 'ABC12345',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email', () => {
    const result = RegisterRequestSchema.safeParse({ email: 'not-an-email', password: 'supersecret' });
    expect(result.success).toBe(false);
  });

  it('rejects a password shorter than 8 characters', () => {
    const result = RegisterRequestSchema.safeParse({ email: 'a@example.com', password: 'short' });
    expect(result.success).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  it('accepts a valid login payload', () => {
    const result = LoginRequestSchema.safeParse({ email: 'a@example.com', password: 'anything' });
    expect(result.success).toBe(true);
  });
});

describe('AuthMeResponseSchema', () => {
  it('accepts a response with no space yet', () => {
    const result = AuthMeResponseSchema.safeParse({
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com', createdAt: new Date().toISOString() },
      space: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a response with a paired space', () => {
    const result = AuthMeResponseSchema.safeParse({
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com', createdAt: new Date().toISOString() },
      space: {
        id: '22222222-2222-2222-2222-222222222222',
        role: 'creator',
        partner: { id: '33333333-3333-3333-3333-333333333333', email: 'b@example.com', createdAt: new Date().toISOString() },
      },
    });
    expect(result.success).toBe(true);
  });
});
