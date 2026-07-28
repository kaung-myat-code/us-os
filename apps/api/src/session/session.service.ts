import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@us-os/database';
import type { Response } from 'express';

// Fail closed: a prod deploy with no JWT_SECRET set must not silently sign
// sessions with the committed dev fallback below (anyone who reads this file
// could forge a valid session token for any user/space).
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

// Dev-only fallback so local/test runs work without extra env setup; set a
// real JWT_SECRET in production.
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me-in-production';

export interface SessionPayload {
  sub: string;
  spaceId: string | null;
}

@Injectable()
export class SessionService {
  static readonly COOKIE_NAME = 'us_os_session';

  constructor(private readonly jwtService: JwtService) {}

  async issueSessionCookie(res: Response, userId: string): Promise<void> {
    const membership = await prisma.spaceMembership.findUnique({ where: { userId } });
    const payload: SessionPayload = { sub: userId, spaceId: membership?.spaceId ?? null };
    const token = this.jwtService.sign(payload);
    res.cookie(SessionService.COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(SessionService.COOKIE_NAME);
  }

  verify(token: string): SessionPayload | null {
    try {
      const decoded = this.jwtService.verify<SessionPayload & { iat?: number; exp?: number }>(token);
      return { sub: decoded.sub, spaceId: decoded.spaceId };
    } catch {
      return null;
    }
  }
}
