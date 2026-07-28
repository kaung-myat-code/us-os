import { Injectable, NestMiddleware } from '@nestjs/common';
import { TenantContext } from '@us-os/database';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const spaceId = req.header('x-space-id');
    if (!spaceId) {
      res.status(400).json({
        type: 'about:blank',
        title: 'Missing tenant context',
        status: 400,
        detail: 'x-space-id header is required',
      });
      return;
    }
    TenantContext.run(spaceId, () => next());
  }
}
