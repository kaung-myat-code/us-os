// apps/api/src/spaces/spaces.service.ts
import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, prisma, type Space } from '@us-os/database';
import { generatePairingCodeString } from './pairing-code.util';

const PAIRING_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GENERATE_ATTEMPTS = 5;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class SpacesService {
  async createSpace(userId: string, name: string): Promise<Space> {
    const existing = await prisma.spaceMembership.findUnique({ where: { userId } });
    if (existing) throw new ConflictException("You're already part of a Space");

    return prisma.$transaction(async (tx) => {
      const space = await tx.space.create({ data: { name } });
      await tx.spaceMembership.create({ data: { userId, spaceId: space.id, role: 'creator' } });
      return space;
    });
  }

  async generatePairingCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
    const membership = await prisma.spaceMembership.findUnique({ where: { userId } });
    if (!membership) throw new ConflictException('You must create a Space before generating a pairing code');

    await prisma.pairingCode.deleteMany({ where: { spaceId: membership.spaceId, redeemedAt: null } });

    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
      try {
        return await prisma.pairingCode.create({
          data: {
            spaceId: membership.spaceId,
            code: generatePairingCodeString(),
            expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
          },
        });
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < MAX_GENERATE_ATTEMPTS - 1) continue;
        throw err;
      }
    }
    throw new Error('Failed to generate a unique pairing code');
  }

  async redeemPairingCode(userId: string, code: string): Promise<{ spaceId: string }> {
    const existing = await prisma.spaceMembership.findUnique({ where: { userId } });
    if (existing) throw new ConflictException("You're already part of a Space");

    const pairingCode = await prisma.pairingCode.findUnique({ where: { code } });
    if (!pairingCode) throw new NotFoundException('Invalid pairing code');
    if (pairingCode.redeemedAt) throw new GoneException('This pairing code has already been used');
    if (pairingCode.expiresAt < new Date()) throw new GoneException('This pairing code has expired');

    return prisma.$transaction(async (tx) => {
      const memberCount = await tx.spaceMembership.count({ where: { spaceId: pairingCode.spaceId } });
      if (memberCount >= 2) throw new ConflictException('This Space is already full');

      await tx.spaceMembership.create({ data: { userId, spaceId: pairingCode.spaceId, role: 'member' } });
      await tx.pairingCode.update({
        where: { id: pairingCode.id },
        data: { redeemedAt: new Date(), redeemedByUserId: userId },
      });

      return { spaceId: pairingCode.spaceId };
    });
  }
}
