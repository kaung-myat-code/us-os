import { z } from 'zod';

export const DecisionStatusSchema = z.enum(['open', 'decided']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const TradeOffTypeSchema = z.enum(['pro', 'con']);
export type TradeOffType = z.infer<typeof TradeOffTypeSchema>;

export const CreateDecisionRequestSchema = z.object({
  title: z.string().min(1).max(200),
  rationale: z.string().max(10000).nullable().optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequestSchema>;

export const UpdateDecisionRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  rationale: z.string().max(10000).nullable().optional(),
});
export type UpdateDecisionRequest = z.infer<typeof UpdateDecisionRequestSchema>;

export const DecideDecisionRequestSchema = z.object({
  chosenOptionId: z.string().uuid(),
  outcomeNote: z.string().max(10000).nullable().optional(),
});
export type DecideDecisionRequest = z.infer<typeof DecideDecisionRequestSchema>;

export const CreateDecisionOptionRequestSchema = z.object({
  label: z.string().min(1).max(200),
});
export type CreateDecisionOptionRequest = z.infer<typeof CreateDecisionOptionRequestSchema>;

export const UpdateDecisionOptionRequestSchema = z.object({
  label: z.string().min(1).max(200),
});
export type UpdateDecisionOptionRequest = z.infer<typeof UpdateDecisionOptionRequestSchema>;

export const CreateTradeOffItemRequestSchema = z.object({
  type: TradeOffTypeSchema,
  label: z.string().min(1).max(300),
  weight: z.number().int().min(1).max(5),
});
export type CreateTradeOffItemRequest = z.infer<typeof CreateTradeOffItemRequestSchema>;

export const UpdateTradeOffItemRequestSchema = z.object({
  type: TradeOffTypeSchema.optional(),
  label: z.string().min(1).max(300).optional(),
  weight: z.number().int().min(1).max(5).optional(),
});
export type UpdateTradeOffItemRequest = z.infer<typeof UpdateTradeOffItemRequestSchema>;

export interface TradeOffItemResponse {
  id: string;
  type: TradeOffType;
  label: string;
  weight: number;
}

export interface DecisionOptionResponse {
  id: string;
  label: string;
  score: number;
  tradeOffs: TradeOffItemResponse[];
}

export interface DecisionListItemResponse {
  id: string;
  title: string;
  status: DecisionStatus;
  rationale: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionDetailResponse {
  id: string;
  title: string;
  status: DecisionStatus;
  rationale: string | null;
  outcomeNote: string | null;
  chosenOptionId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  options: DecisionOptionResponse[];
}
