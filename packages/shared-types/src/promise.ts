import { z } from 'zod';

export const PromiseStatusSchema = z.enum(['pending', 'kept', 'broken']);
export type PromiseStatus = z.infer<typeof PromiseStatusSchema>;

const DUE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const CreatePromiseRequestSchema = z.object({
  title: z.string().min(1).max(200),
  dueDate: z.string().regex(DUE_DATE_REGEX, 'dueDate must be in YYYY-MM-DD format').nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
});
export type CreatePromiseRequest = z.infer<typeof CreatePromiseRequestSchema>;

export const UpdatePromiseRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  dueDate: z.string().regex(DUE_DATE_REGEX, 'dueDate must be in YYYY-MM-DD format').nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
});
export type UpdatePromiseRequest = z.infer<typeof UpdatePromiseRequestSchema>;

export const ResolvePromiseRequestSchema = z.object({
  status: z.enum(['kept', 'broken']),
  note: z.string().max(10000).nullable().optional(),
});
export type ResolvePromiseRequest = z.infer<typeof ResolvePromiseRequestSchema>;

export interface PromiseResponse {
  id: string;
  title: string;
  promisedBy: string;
  dueDate: string | null;
  status: PromiseStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
