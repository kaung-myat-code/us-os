import { ConflictException, GoneException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import * as bcrypt from 'bcrypt';
import type { AuthMeResponse, RegisterRequest, UserProfile } from '@us-os/shared-types';

const SALT_ROUNDS = 10;

function toUserProfile(user: { id: string; email: string; createdAt: Date }): UserProfile {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

@Injectable()
export class AuthService {
  async register(dto: RegisterRequest): Promise<{ id: string; email: string; createdAt: Date }> {
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('An account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    if (!dto.pairingCode) {
      const user = await prisma.user.create({ data: { email: dto.email, passwordHash } });
      return { id: user.id, email: user.email, createdAt: user.createdAt };
    }

    // Combined register+redeem: one atomic transaction so an invalid code
    // never leaves an orphaned User row. `prisma.$transaction` here is the
    // raw (non-tenant-extended) escape hatch documented in client.ts — safe
    // because none of these models are tenant-scoped.
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: dto.email, passwordHash } });

      const code = await tx.pairingCode.findUnique({ where: { code: dto.pairingCode } });
      if (!code) throw new NotFoundException('Invalid pairing code');
      if (code.redeemedAt) throw new GoneException('This pairing code has already been used');
      if (code.expiresAt < new Date()) throw new GoneException('This pairing code has expired');

      const memberCount = await tx.spaceMembership.count({ where: { spaceId: code.spaceId } });
      if (memberCount >= 2) throw new ConflictException('This Space is already full');

      await tx.spaceMembership.create({ data: { userId: user.id, spaceId: code.spaceId, role: 'member' } });
      await tx.pairingCode.update({
        where: { id: code.id },
        data: { redeemedAt: new Date(), redeemedByUserId: user.id },
      });

      return { id: user.id, email: user.email, createdAt: user.createdAt };
    });
  }

  async validateUser(email: string, password: string): Promise<{ userId: string }> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid email or password');

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) throw new UnauthorizedException('Invalid email or password');

    return { userId: user.id };
  }

  async getMe(userId: string): Promise<AuthMeResponse> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const membership = await prisma.spaceMembership.findUnique({ where: { userId } });

    if (!membership) {
      return { user: toUserProfile(user), space: null };
    }

    const partnerMembership = await prisma.spaceMembership.findFirst({
      where: { spaceId: membership.spaceId, userId: { not: userId } },
      include: { user: true },
    });

    return {
      user: toUserProfile(user),
      space: {
        id: membership.spaceId,
        role: membership.role as 'creator' | 'member',
        partner: partnerMembership ? toUserProfile(partnerMembership.user) : null,
      },
    };
  }
}
