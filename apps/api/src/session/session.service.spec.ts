import { JwtService } from '@nestjs/jwt';
import { prisma } from '@us-os/database';
import type { Response } from 'express';
import { JWT_SECRET, SessionService } from './session.service';

describe('SessionService (integration)', () => {
  let sessionService: SessionService;
  let userId: string;
  let spaceId: string;

  beforeAll(async () => {
    sessionService = new SessionService(new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } }));

    const user = await prisma.user.create({
      data: { email: `session-test-${Date.now()}@example.com`, passwordHash: 'irrelevant' },
    });
    userId = user.id;

    const space = await prisma.space.create({ data: { name: 'Session Test Space' } });
    spaceId = space.id;
    await prisma.spaceMembership.create({ data: { userId, spaceId, role: 'creator' } });
  });

  afterAll(async () => {
    await prisma.spaceMembership.deleteMany({ where: { userId } });
    await prisma.space.delete({ where: { id: spaceId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('issues a cookie whose payload carries the user\'s current spaceId', async () => {
    let capturedCookieValue: string | undefined;
    const res = {
      cookie: jest.fn((_name: string, value: string) => {
        capturedCookieValue = value;
      }),
    } as unknown as Response;

    await sessionService.issueSessionCookie(res, userId);

    expect(res.cookie).toHaveBeenCalledWith(
      SessionService.COOKIE_NAME,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
    const payload = sessionService.verify(capturedCookieValue as string);
    expect(payload).toEqual({ sub: userId, spaceId });
  });

  it('issues a cookie with spaceId null for a user with no membership', async () => {
    const soloUser = await prisma.user.create({
      data: { email: `session-test-solo-${Date.now()}@example.com`, passwordHash: 'irrelevant' },
    });

    let capturedCookieValue: string | undefined;
    const res = {
      cookie: jest.fn((_name: string, value: string) => {
        capturedCookieValue = value;
      }),
    } as unknown as Response;

    await sessionService.issueSessionCookie(res, soloUser.id);
    const payload = sessionService.verify(capturedCookieValue as string);
    expect(payload).toEqual({ sub: soloUser.id, spaceId: null });

    await prisma.user.delete({ where: { id: soloUser.id } });
  });

  it('clearSessionCookie clears the cookie', () => {
    const res = { clearCookie: jest.fn() } as unknown as Response;
    sessionService.clearSessionCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(SessionService.COOKIE_NAME);
  });

  it('verify returns null for a garbage token', () => {
    expect(sessionService.verify('not-a-real-token')).toBeNull();
  });
});
