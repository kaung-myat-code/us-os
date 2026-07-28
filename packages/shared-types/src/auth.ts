import { z } from 'zod';

export const RegisterRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  pairingCode: z.string().length(8).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const SpaceMembershipRoleSchema = z.enum(['creator', 'member']);
export type SpaceMembershipRole = z.infer<typeof SpaceMembershipRoleSchema>;

export const AuthMeResponseSchema = z.object({
  user: UserProfileSchema,
  space: z
    .object({
      id: z.string().uuid(),
      role: SpaceMembershipRoleSchema,
      partner: UserProfileSchema.nullable(),
    })
    .nullable(),
});
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
