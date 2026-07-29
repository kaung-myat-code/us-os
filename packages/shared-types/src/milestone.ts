import { z } from 'zod';

export const MilestoneCategorySchema = z.enum(['milestone', 'memory', 'decision', 'other']);
export type MilestoneCategory = z.infer<typeof MilestoneCategorySchema>;

const EVENT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const CreateMilestoneRequestSchema = z.object({
  title: z.string().min(1).max(500),
  eventDate: z.string().regex(EVENT_DATE_REGEX, 'eventDate must be in YYYY-MM-DD format'),
  category: MilestoneCategorySchema.default('other'),
  note: z.string().max(10000).nullable().optional(),
});
export type CreateMilestoneRequest = z.infer<typeof CreateMilestoneRequestSchema>;

export const UpdateMilestoneRequestSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  eventDate: z.string().regex(EVENT_DATE_REGEX, 'eventDate must be in YYYY-MM-DD format').optional(),
  category: MilestoneCategorySchema.optional(),
  note: z.string().max(10000).nullable().optional(),
});
export type UpdateMilestoneRequest = z.infer<typeof UpdateMilestoneRequestSchema>;

export interface MilestoneResponse {
  id: string;
  title: string;
  eventDate: string;
  category: MilestoneCategory;
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
