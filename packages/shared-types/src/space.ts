import { z } from 'zod';

export const CreateSpaceRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequestSchema>;

export const PairingCodeResponseSchema = z.object({
  code: z.string().length(8),
  expiresAt: z.string().datetime(),
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

export const RedeemPairingCodeRequestSchema = z.object({
  code: z.string().length(8),
});
export type RedeemPairingCodeRequest = z.infer<typeof RedeemPairingCodeRequestSchema>;
