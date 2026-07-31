import { z } from 'zod';

export const GoalCategorySchema = z.enum(['financial', 'health', 'travel', 'career', 'relationship', 'other']);
export type GoalCategory = z.infer<typeof GoalCategorySchema>;

export const GoalStatusSchema = z.enum(['active', 'achieved', 'abandoned']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const CreateGoalRequestSchema = z.object({
  title: z.string().min(1).max(200),
  category: GoalCategorySchema.optional(),
  targetDate: z.string().nullable().optional(),
  description: z.string().max(10000).nullable().optional(),
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequestSchema>;

export const UpdateGoalRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: GoalCategorySchema.optional(),
  targetDate: z.string().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  status: GoalStatusSchema.optional(),
  description: z.string().max(10000).nullable().optional(),
});
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequestSchema>;

export interface GoalResponse {
  id: string;
  title: string;
  category: GoalCategory;
  targetDate: string | null;
  progress: number;
  status: GoalStatus;
  achievedAt: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
