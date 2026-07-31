import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreateGoalRequestSchema,
  UpdateGoalRequestSchema,
  type CreateGoalRequest,
  type UpdateGoalRequest,
} from '@us-os/shared-types';
import type { Request } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import { requireSpaceId } from '../milestones/require-space';
import { GoalsService } from './goals.service';

@UseGuards(JwtAuthGuard)
@Controller('goals')
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Get()
  async list(@Req() req: Request) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.goalsService.list();
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body(createZodValidationPipe(CreateGoalRequestSchema)) dto: CreateGoalRequest,
  ) {
    const { userId, spaceId } = req.user as AuthenticatedUser;
    const scopedSpaceId = requireSpaceId(spaceId);
    return this.goalsService.create(scopedSpaceId, userId, dto);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.goalsService.get(id);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(createZodValidationPipe(UpdateGoalRequestSchema)) dto: UpdateGoalRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.goalsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    await this.goalsService.remove(id);
  }
}
