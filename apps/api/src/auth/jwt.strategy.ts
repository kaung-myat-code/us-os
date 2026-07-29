import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { JWT_SECRET, SessionService, type SessionPayload } from '../session/session.service';
import type { AuthenticatedUser } from './types';

function fromSessionCookie(req: Request): string | null {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[SessionService.COOKIE_NAME] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromSessionCookie]),
      secretOrKey: JWT_SECRET,
    });
  }

  validate(payload: SessionPayload): AuthenticatedUser {
    return { userId: payload.sub, spaceId: payload.spaceId };
  }
}
