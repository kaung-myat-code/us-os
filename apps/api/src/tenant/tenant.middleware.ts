import { Injectable, NestMiddleware } from '@nestjs/common';
import { TenantContext } from '@us-os/database';
import type { NextFunction, Request, Response } from 'express';
import { SessionService } from '../session/session.service';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly sessionService: SessionService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      SessionService.COOKIE_NAME
    ];
    const payload = token ? this.sessionService.verify(token) : null;

    if (payload?.spaceId) {
      TenantContext.run(payload.spaceId, () => next());
    } else {
      next();
    }
  }
}
