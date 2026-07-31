import { describe, expect, it } from 'vitest';
import { CreatePromiseRequestSchema, UpdatePromiseRequestSchema, ResolvePromiseRequestSchema, PromiseStatusSchema } from './promise';

describe('PromiseStatusSchema', () => {
  it('accepts pending, kept, broken', () => {
    for (const status of ['pending', 'kept', 'broken']) {
      expect(PromiseStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(PromiseStatusSchema.safeParse('cancelled').success).toBe(false);
  });
});

describe('CreatePromiseRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'Book the flights' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 characters', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects a note over 10000 characters', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'x', note: 'a'.repeat(10001) }).success).toBe(false);
  });

  it('accepts an explicit null note', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'x', note: null }).success).toBe(true);
  });
});

describe('UpdatePromiseRequestSchema', () => {
  it('accepts an empty object', () => {
    expect(UpdatePromiseRequestSchema.safeParse({}).success).toBe(true);
  });

  it('distinguishes an absent note key from an explicit null', () => {
    const omitted = UpdatePromiseRequestSchema.parse({ title: 'x' });
    const explicit = UpdatePromiseRequestSchema.parse({ title: 'x', note: null });
    expect('note' in omitted).toBe(false);
    expect('note' in explicit).toBe(true);
  });
});

describe('ResolvePromiseRequestSchema', () => {
  it('accepts kept and broken', () => {
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'kept' }).success).toBe(true);
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'broken' }).success).toBe(true);
  });

  it('rejects pending as a resolve target', () => {
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('rejects a missing status', () => {
    expect(ResolvePromiseRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an optional note', () => {
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'kept', note: 'Booked it' }).success).toBe(true);
  });
});
