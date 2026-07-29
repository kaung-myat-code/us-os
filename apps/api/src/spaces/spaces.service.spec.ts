// apps/api/src/spaces/spaces.service.spec.ts
import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import { SpacesService } from './spaces.service';

describe('SpacesService (integration)', () => {
  const spacesService = new SpacesService();
  const createdUserIds: string[] = [];
  const createdSpaceIds: string[] = [];

  afterAll(async () => {
    await prisma.pairingCode.deleteMany({ where: { spaceId: { in: createdSpaceIds } } });
    await prisma.spaceMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.space.deleteMany({ where: { id: { in: createdSpaceIds } } });
    await prisma.$disconnect();
  });

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `spaces-service-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: 'x' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  describe('createSpace', () => {
    it('creates a Space and a creator membership', async () => {
      const user = await createUser('create');
      const space = await spacesService.createSpace(user.id, 'Our Space');
      createdSpaceIds.push(space.id);

      const membership = await prisma.spaceMembership.findUnique({ where: { userId: user.id } });
      expect(membership).toMatchObject({ spaceId: space.id, role: 'creator' });
    });

    it('rejects creating a second Space for a user who already has one', async () => {
      const user = await createUser('create-dup');
      const space = await spacesService.createSpace(user.id, 'First Space');
      createdSpaceIds.push(space.id);

      await expect(spacesService.createSpace(user.id, 'Second Space')).rejects.toThrow(ConflictException);
    });

    it('rejects a duplicate membership at the DB level even bypassing the app-layer check', async () => {
      // Proves the unique index backstop independently of SpacesService's
      // own pre-check — inserts two SpaceMembership rows for the same userId
      // directly via Prisma, skipping createSpace()'s guard entirely.
      const user = await createUser('create-dup-raw');
      const spaceOne = await prisma.space.create({ data: { name: 'Raw Space One' } });
      createdSpaceIds.push(spaceOne.id);
      const spaceTwo = await prisma.space.create({ data: { name: 'Raw Space Two' } });
      createdSpaceIds.push(spaceTwo.id);

      await prisma.spaceMembership.create({ data: { userId: user.id, spaceId: spaceOne.id, role: 'creator' } });

      await expect(
        prisma.spaceMembership.create({ data: { userId: user.id, spaceId: spaceTwo.id, role: 'creator' } }),
      ).rejects.toThrow();
    });
  });

  describe('generatePairingCode', () => {
    it('creates an 8-char code that expires ~24h out', async () => {
      const user = await createUser('gen');
      const space = await spacesService.createSpace(user.id, 'Gen Space');
      createdSpaceIds.push(space.id);

      const result = await spacesService.generatePairingCode(user.id);

      expect(result.code).toHaveLength(8);
      const hoursUntilExpiry = (result.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursUntilExpiry).toBeGreaterThan(23.9);
      expect(hoursUntilExpiry).toBeLessThan(24.1);
    });

    it('deletes the previous unredeemed code when generating a new one', async () => {
      const user = await createUser('regen');
      const space = await spacesService.createSpace(user.id, 'Regen Space');
      createdSpaceIds.push(space.id);

      const first = await spacesService.generatePairingCode(user.id);
      const second = await spacesService.generatePairingCode(user.id);

      expect(second.code).not.toBe(first.code);
      expect(await prisma.pairingCode.findUnique({ where: { code: first.code } })).toBeNull();
    });

    it('rejects generating a code for a user with no Space', async () => {
      const user = await createUser('gen-no-space');
      await expect(spacesService.generatePairingCode(user.id)).rejects.toThrow(ConflictException);
    });
  });

  describe('redeemPairingCode', () => {
    it('creates a member SpaceMembership and marks the code redeemed', async () => {
      const creator = await createUser('redeem-creator');
      const space = await spacesService.createSpace(creator.id, 'Redeem Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);

      const joiner = await createUser('redeem-joiner');
      const result = await spacesService.redeemPairingCode(joiner.id, code);

      expect(result.spaceId).toBe(space.id);
      const membership = await prisma.spaceMembership.findUnique({ where: { userId: joiner.id } });
      expect(membership).toMatchObject({ spaceId: space.id, role: 'member' });
      const redeemedCode = await prisma.pairingCode.findUniqueOrThrow({ where: { code } });
      expect(redeemedCode.redeemedByUserId).toBe(joiner.id);
    });

    it('rejects an unknown code with 404', async () => {
      const user = await createUser('redeem-404');
      await expect(spacesService.redeemPairingCode(user.id, 'NOPE0000')).rejects.toThrow(NotFoundException);
    });

    it('rejects an expired code with 410', async () => {
      const creator = await createUser('redeem-expired-creator');
      const space = await prisma.space.create({ data: { name: 'Expired Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      await prisma.pairingCode.create({
        data: { spaceId: space.id, code: 'EXPIRED1', expiresAt: new Date(Date.now() - 1000) },
      });

      const joiner = await createUser('redeem-expired-joiner');
      await expect(spacesService.redeemPairingCode(joiner.id, 'EXPIRED1')).rejects.toThrow(GoneException);
    });

    it('rejects an already-redeemed code with 410', async () => {
      const creator = await createUser('redeem-used-creator');
      const space = await spacesService.createSpace(creator.id, 'Used Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);
      const firstJoiner = await createUser('redeem-used-joiner-1');
      await spacesService.redeemPairingCode(firstJoiner.id, code);

      const secondJoiner = await createUser('redeem-used-joiner-2');
      await expect(spacesService.redeemPairingCode(secondJoiner.id, code)).rejects.toThrow(GoneException);
    });

    it('rejects redeeming into a Space that already has 2 members with 409', async () => {
      const creator = await createUser('redeem-full-creator');
      const space = await spacesService.createSpace(creator.id, 'Full Space');
      createdSpaceIds.push(space.id);
      const { code: firstCode } = await spacesService.generatePairingCode(creator.id);
      const firstJoiner = await createUser('redeem-full-joiner-1');
      await spacesService.redeemPairingCode(firstJoiner.id, firstCode);

      // Space now has 2 members. Directly insert a third, still-valid code
      // (bypassing generatePairingCode, which would itself reject issuing a
      // code once the space is full only at the app's discretion — this
      // proves the redemption-time capacity check independent of that).
      await prisma.pairingCode.create({
        data: { spaceId: space.id, code: 'FULLCODE', expiresAt: new Date(Date.now() + 60_000) },
      });

      const thirdUser = await createUser('redeem-full-joiner-2');
      await expect(spacesService.redeemPairingCode(thirdUser.id, 'FULLCODE')).rejects.toThrow(ConflictException);
    });

    it('closes the double-redemption race: two concurrent redeemers of the same valid code, only one succeeds and the Space ends up with exactly 2 members', async () => {
      const creator = await createUser('redeem-race-creator');
      const space = await spacesService.createSpace(creator.id, 'Race Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);

      const joinerA = await createUser('redeem-race-joiner-a');
      const joinerB = await createUser('redeem-race-joiner-b');

      const results = await Promise.allSettled([
        spacesService.redeemPairingCode(joinerA.id, code),
        spacesService.redeemPairingCode(joinerB.id, code),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(GoneException);

      const memberCount = await prisma.spaceMembership.count({ where: { spaceId: space.id } });
      expect(memberCount).toBe(2);
    });

    it('rejects redemption from a user who already belongs to a Space with 409', async () => {
      const creator = await createUser('redeem-caller-has-space-creator');
      const space = await spacesService.createSpace(creator.id, 'Caller Has Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);

      const otherCreator = await createUser('redeem-caller-has-space-other');
      const otherSpace = await spacesService.createSpace(otherCreator.id, 'Other Space');
      createdSpaceIds.push(otherSpace.id);

      await expect(spacesService.redeemPairingCode(otherCreator.id, code)).rejects.toThrow(ConflictException);
    });
  });
});
