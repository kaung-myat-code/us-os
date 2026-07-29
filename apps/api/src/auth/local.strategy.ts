import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './types';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string): Promise<AuthenticatedUser> {
    const { userId } = await this.authService.validateUser(email, password);
    // spaceId is intentionally not resolved here — SessionService re-reads
    // current membership at cookie-issuance time in the controller, which is
    // the single source of truth for spaceId (see SessionService.issueSessionCookie).
    return { userId, spaceId: null };
  }
}
