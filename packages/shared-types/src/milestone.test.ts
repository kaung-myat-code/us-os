import { describe, expect, it } from 'vitest';
import { CreateMilestoneRequestSchema, MilestoneCategorySchema, UpdateMilestoneRequestSchema } from './milestone';

describe('MilestoneCategorySchema', () => {
  it('accepts the four known categories', () => {
    for (const category of ['milestone', 'memory', 'decision', 'other']) {
      expect(MilestoneCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(MilestoneCategorySchema.safeParse('vacation').success).toBe(false);
  });
});

describe('CreateMilestoneRequestSchema', () => {
  it('accepts a minimal valid payload and defaults category to other', () => {
    const result = CreateMilestoneRequestSchema.safeParse({ title: 'First apartment', eventDate: '2024-03-15' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.category).toBe('other');
  });

  it('rejects an empty title', () => {
    expect(CreateMilestoneRequestSchema.safeParse({ title: '', eventDate: '2024-03-15' }).success).toBe(false);
  });

  it('rejects a full datetime string for eventDate', () => {
    expect(
      CreateMilestoneRequestSchema.safeParse({ title: 'x', eventDate: '2024-03-15T10:30:00Z' }).success,
    ).toBe(false);
  });

  it('rejects a note over 10000 characters', () => {
    const result = CreateMilestoneRequestSchema.safeParse({
      title: 'x',
      eventDate: '2024-03-15',
      note: 'a'.repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit null note', () => {
    expect(
      CreateMilestoneRequestSchema.safeParse({ title: 'x', eventDate: '2024-03-15', note: null }).success,
    ).toBe(true);
  });
});

describe('UpdateMilestoneRequestSchema', () => {
  it('accepts a partial update with only a note', () => {
    expect(UpdateMilestoneRequestSchema.safeParse({ note: 'updated' }).success).toBe(true);
  });

  it('distinguishes an absent note key from an explicit null', () => {
    const omitted = UpdateMilestoneRequestSchema.parse({ title: 'x' });
    const explicit = UpdateMilestoneRequestSchema.parse({ title: 'x', note: null });
    expect('note' in omitted).toBe(false);
    expect('note' in explicit).toBe(true);
    expect(explicit.note).toBeNull();
  });

  it('accepts an empty object (no fields changed)', () => {
    expect(UpdateMilestoneRequestSchema.safeParse({}).success).toBe(true);
  });
});
