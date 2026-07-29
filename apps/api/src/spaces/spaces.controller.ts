import { Body, Controller, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import {
  CreateSpaceRequestSchema,
  RedeemPairingCodeRequestSchema,
  type CreateSpaceRequest,
  type RedeemPairingCodeRequest,
} from '@us-os/shared-types';
import type { Request, Response } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import { SessionService } from '../session/session.service';
import { SpacesService } from './spaces.service';

@UseGuards(JwtAuthGuard)
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spacesService: SpacesService,
    private readonly sessionService: SessionService,
  ) {}

  @Post()
  @UsePipes(createZodValidationPipe(CreateSpaceRequestSchema))
  async create(@Req() req: Request, @Body() dto: CreateSpaceRequest, @Res({ passthrough: true }) res: Response) {
    const { userId } = req.user as AuthenticatedUser;
    const space = await this.spacesService.createSpace(userId, dto.name);
    await this.sessionService.issueSessionCookie(res, userId);
    return space;
  }

  @Post('pairing-codes')
  async generateCode(@Req() req: Request) {
    const { userId } = req.user as AuthenticatedUser;
    const { code, expiresAt } = await this.spacesService.generatePairingCode(userId);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  @Post('pairing-codes/redeem')
  @UsePipes(createZodValidationPipe(RedeemPairingCodeRequestSchema))
  async redeem(
    @Req() req: Request,
    @Body() dto: RedeemPairingCodeRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId } = req.user as AuthenticatedUser;
    const result = await this.spacesService.redeemPairingCode(userId, dto.code);
    await this.sessionService.issueSessionCookie(res, userId);
    return result;
  }
}
