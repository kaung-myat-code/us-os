import { describe, expect, it } from 'vitest';
import {
  CreateDecisionRequestSchema,
  UpdateDecisionRequestSchema,
  DecideDecisionRequestSchema,
  CreateDecisionOptionRequestSchema,
  CreateTradeOffItemRequestSchema,
  UpdateTradeOffItemRequestSchema,
  TradeOffTypeSchema,
} from './decision';

describe('TradeOffTypeSchema', () => {
  it('accepts pro and con', () => {
    expect(TradeOffTypeSchema.safeParse('pro').success).toBe(true);
    expect(TradeOffTypeSchema.safeParse('con').success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(TradeOffTypeSchema.safeParse('neutral').success).toBe(false);
  });
});

describe('CreateDecisionRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: 'Where should we live?' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 characters', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects a rationale over 10000 characters', () => {
    expect(
      CreateDecisionRequestSchema.safeParse({ title: 'x', rationale: 'a'.repeat(10001) }).success,
    ).toBe(false);
  });

  it('accepts an explicit null rationale', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: 'x', rationale: null }).success).toBe(true);
  });
});

describe('UpdateDecisionRequestSchema', () => {
  it('distinguishes an absent rationale key from an explicit null', () => {
    const omitted = UpdateDecisionRequestSchema.parse({ title: 'x' });
    const explicit = UpdateDecisionRequestSchema.parse({ title: 'x', rationale: null });
    expect('rationale' in omitted).toBe(false);
    expect('rationale' in explicit).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(UpdateDecisionRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('DecideDecisionRequestSchema', () => {
  it('requires chosenOptionId to be a uuid', () => {
    expect(DecideDecisionRequestSchema.safeParse({ chosenOptionId: 'not-a-uuid' }).success).toBe(false);
    expect(
      DecideDecisionRequestSchema.safeParse({ chosenOptionId: '11111111-1111-1111-1111-111111111111' }).success,
    ).toBe(true);
  });

  it('rejects a missing chosenOptionId', () => {
    expect(DecideDecisionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an optional outcomeNote', () => {
    expect(
      DecideDecisionRequestSchema.safeParse({
        chosenOptionId: '11111111-1111-1111-1111-111111111111',
        outcomeNote: 'We chose Austin',
      }).success,
    ).toBe(true);
  });
});

describe('CreateDecisionOptionRequestSchema', () => {
  it('rejects an empty label', () => {
    expect(CreateDecisionOptionRequestSchema.safeParse({ label: '' }).success).toBe(false);
  });
});

describe('CreateTradeOffItemRequestSchema', () => {
  it('accepts a weight between 1 and 5', () => {
    for (const weight of [1, 3, 5]) {
      expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight }).success).toBe(true);
    }
  });

  it('rejects a weight outside 1-5', () => {
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight: 0 }).success).toBe(false);
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight: 6 }).success).toBe(false);
  });

  it('rejects a non-integer weight', () => {
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight: 2.5 }).success).toBe(false);
  });

  it('rejects an invalid type', () => {
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'neutral', label: 'x', weight: 3 }).success).toBe(false);
  });
});

describe('UpdateTradeOffItemRequestSchema', () => {
  it('accepts a partial update with only weight', () => {
    expect(UpdateTradeOffItemRequestSchema.safeParse({ weight: 4 }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(UpdateTradeOffItemRequestSchema.safeParse({}).success).toBe(true);
  });
});
