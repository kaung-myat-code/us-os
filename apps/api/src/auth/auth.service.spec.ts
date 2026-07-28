import { ConflictException, GoneException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import { AuthService } from './auth.service';

describe('AuthService (integration)', () => {
  const authService = new AuthService();
  const createdUserIds: string[] = [];
  const createdSpaceIds: string[] = [];

  afterAll(async () => {
    await prisma.spaceMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.pairingCode.deleteMany({ where: { spaceId: { in: createdSpaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.space.deleteMany({ where: { id: { in: createdSpaceIds } } });
    await prisma.$disconnect();
  });

  function uniqueEmail(label: string): string {
    return `auth-service-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  }

  describe('register', () => {
    it('creates a user with a hashed password and no membership', async () => {
      const email = uniqueEmail('register');
      const user = await authService.register({ email, password: 'supersecret' });
      createdUserIds.push(user.id);

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.passwordHash).not.toBe('supersecret');
      expect(await prisma.spaceMembership.findUnique({ where: { userId: user.id } })).toBeNull();
    });

    it('rejects a duplicate email with 409', async () => {
      const email = uniqueEmail('dup');
      const user = await authService.register({ email, password: 'supersecret' });
      createdUserIds.push(user.id);

      await expect(authService.register({ email, password: 'different' })).rejects.toThrow(ConflictException);
    });

    it('joins the pairing code\'s space atomically when pairingCode is provided', async () => {
      const creator = await authService.register({ email: uniqueEmail('creator'), password: 'supersecret' });
      createdUserIds.push(creator.id);
      const space = await prisma.space.create({ data: { name: 'Combined Register Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      const code = await prisma.pairingCode.create({
        data: { spaceId: space.id, code: 'JOIN0001', expiresAt: new Date(Date.now() + 60_000) },
      });

      const joiner = await authService.register({
        email: uniqueEmail('joiner'),
        password: 'supersecret',
        pairingCode: 'JOIN0001',
      });
      createdUserIds.push(joiner.id);

      const membership = await prisma.spaceMembership.findUnique({ where: { userId: joiner.id } });
      expect(membership?.spaceId).toBe(space.id);
      expect(membership?.role).toBe('member');
      const redeemed = await prisma.pairingCode.findUniqueOrThrow({ where: { id: code.id } });
      expect(redeemed.redeemedByUserId).toBe(joiner.id);
    });

    it('rolls back user creation when the pairing code is invalid', async () => {
      const email = uniqueEmail('rollback');

      await expect(
        authService.register({ email, password: 'supersecret', pairingCode: 'NOPE0000' }),
      ).rejects.toThrow(NotFoundException);

      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });

    it('rejects an already-redeemed pairing code with 410, rolling back registration', async () => {
      const creator = await authService.register({ email: uniqueEmail('creator2'), password: 'supersecret' });
      createdUserIds.push(creator.id);
      const space = await prisma.space.create({ data: { name: 'Already Redeemed Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      await prisma.pairingCode.create({
        data: {
          spaceId: space.id,
          code: 'USED0001',
          expiresAt: new Date(Date.now() + 60_000),
          redeemedAt: new Date(),
          redeemedByUserId: creator.id,
        },
      });

      const email = uniqueEmail('rollback2');
      await expect(
        authService.register({ email, password: 'supersecret', pairingCode: 'USED0001' }),
      ).rejects.toThrow(GoneException);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  });

  describe('validateUser', () => {
    it('resolves with userId for correct credentials', async () => {
      const email = uniqueEmail('validate');
      const user = await authService.register({ email, password: 'correct-password' });
      createdUserIds.push(user.id);

      const result = await authService.validateUser(email, 'correct-password');
      expect(result).toEqual({ userId: user.id });
    });

    it('rejects incorrect credentials with 401', async () => {
      const email = uniqueEmail('validate-wrong');
      const user = await authService.register({ email, password: 'correct-password' });
      createdUserIds.push(user.id);

      await expect(authService.validateUser(email, 'wrong-password')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown email with 401', async () => {
      await expect(authService.validateUser(uniqueEmail('unknown'), 'anything')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('getMe', () => {
    it('returns space: null for a user with no membership', async () => {
      const email = uniqueEmail('getme-solo');
      const user = await authService.register({ email, password: 'supersecret' });
      createdUserIds.push(user.id);

      const me = await authService.getMe(user.id);
      expect(me).toEqual({ user: { id: user.id, email, createdAt: user.createdAt.toISOString() }, space: null });
    });

    it('returns the partner once both users are paired', async () => {
      const creator = await authService.register({ email: uniqueEmail('getme-creator'), password: 'supersecret' });
      createdUserIds.push(creator.id);
      const space = await prisma.space.create({ data: { name: 'GetMe Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      const member = await authService.register({ email: uniqueEmail('getme-member'), password: 'supersecret' });
      createdUserIds.push(member.id);
      await prisma.spaceMembership.create({ data: { userId: member.id, spaceId: space.id, role: 'member' } });

      const me = await authService.getMe(creator.id);
      expect(me.space).toMatchObject({ id: space.id, role: 'creator' });
      expect(me.space?.partner?.id).toBe(member.id);
    });
  });
});
