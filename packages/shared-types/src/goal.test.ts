import { describe, expect, it } from 'vitest';
import { CreateGoalRequestSchema, UpdateGoalRequestSchema, GoalCategorySchema, GoalStatusSchema } from './goal';

describe('GoalCategorySchema', () => {
  it('accepts each known category', () => {
    for (const category of ['financial', 'health', 'travel', 'career', 'relationship', 'other']) {
      expect(GoalCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(GoalCategorySchema.safeParse('hobby').success).toBe(false);
  });
});

describe('GoalStatusSchema', () => {
  it('accepts active, achieved, abandoned', () => {
    for (const status of ['active', 'achieved', 'abandoned']) {
      expect(GoalStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(GoalStatusSchema.safeParse('paused').success).toBe(false);
  });
});

describe('CreateGoalRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'Save for a house' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 characters', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects an invalid category', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', category: 'hobby' }).success).toBe(false);
  });

  it('rejects a description over 10000 characters', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', description: 'a'.repeat(10001) }).success).toBe(false);
  });

  it('accepts an explicit null description', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', description: null }).success).toBe(true);
  });

  it('rejects a malformed targetDate', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', targetDate: 'not-a-date' }).success).toBe(false);
  });

  it('accepts a null targetDate', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', targetDate: null }).success).toBe(true);
  });

  it('accepts a valid targetDate', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', targetDate: '2026-12-31' }).success).toBe(true);
  });
});

describe('UpdateGoalRequestSchema', () => {
  it('accepts an empty object', () => {
    expect(UpdateGoalRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts progress and status independently, in any combination', () => {
    expect(UpdateGoalRequestSchema.safeParse({ progress: 100, status: 'active' }).success).toBe(true);
    expect(UpdateGoalRequestSchema.safeParse({ progress: 70, status: 'achieved' }).success).toBe(true);
  });

  it('rejects progress outside 0-100', () => {
    expect(UpdateGoalRequestSchema.safeParse({ progress: -1 }).success).toBe(false);
    expect(UpdateGoalRequestSchema.safeParse({ progress: 101 }).success).toBe(false);
  });

  it('rejects a non-integer progress', () => {
    expect(UpdateGoalRequestSchema.safeParse({ progress: 50.5 }).success).toBe(false);
  });

  it('distinguishes an absent description key from an explicit null', () => {
    const omitted = UpdateGoalRequestSchema.parse({ title: 'x' });
    const explicit = UpdateGoalRequestSchema.parse({ title: 'x', description: null });
    expect('description' in omitted).toBe(false);
    expect('description' in explicit).toBe(true);
  });
});
