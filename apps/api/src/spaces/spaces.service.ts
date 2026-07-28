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
      // Atomic compare-and-set FIRST: this is the actual race-closer. Postgres
      // takes a row-level lock on the target PairingCode row for the duration
      // of this UPDATE. A concurrent redeemer's identical UPDATE blocks until
      // this transaction commits or rolls back, then re-evaluates the WHERE
      // clause (redeemedAt: null) under READ COMMITTED against the now-committed
      // row, sees redeemedAt is no longer null, and affects 0 rows. That makes
      // "count === 0" a deterministic, race-safe signal that someone else won.
      //
      // Deliberately ordered before the memberCount check below: if memberCount
      // were checked first, both concurrent transactions could read
      // memberCount < 2 before either commits (READ COMMITTED does not lock on
      // plain SELECTs), so the loser would inconsistently surface as either
      // GoneException or ConflictException depending on timing. Gating on the
      // atomic updateMany first guarantees the loser always sees GoneException.
      const { count } = await tx.pairingCode.updateMany({
        where: { id: pairingCode.id, redeemedAt: null },
        data: { redeemedAt: new Date(), redeemedByUserId: userId },
      });
      if (count === 0) {
        throw new GoneException('This pairing code has already been used');
      }

      // Still useful as a capacity guard (and the transaction rollback undoes
      // the updateMany above if it fires), but on its own it is not a
      // sufficient concurrency guard — see the updateMany comment above.
      const memberCount = await tx.spaceMembership.count({ where: { spaceId: pairingCode.spaceId } });
      if (memberCount >= 2) throw new ConflictException('This Space is already full');

      await tx.spaceMembership.create({ data: { userId, spaceId: pairingCode.spaceId, role: 'member' } });

      return { spaceId: pairingCode.spaceId };
    });
  }
}
