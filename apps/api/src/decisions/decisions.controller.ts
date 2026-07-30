import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreateDecisionRequestSchema,
  CreateDecisionOptionRequestSchema,
  CreateTradeOffItemRequestSchema,
  UpdateDecisionRequestSchema,
  UpdateDecisionOptionRequestSchema,
  UpdateTradeOffItemRequestSchema,
  type CreateDecisionRequest,
  type CreateDecisionOptionRequest,
  type CreateTradeOffItemRequest,
  type UpdateDecisionRequest,
  type UpdateDecisionOptionRequest,
  type UpdateTradeOffItemRequest,
} from '@us-os/shared-types';
import type { Request } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import { requireSpaceId } from '../milestones/require-space';
import { DecisionsService } from './decisions.service';

@UseGuards(JwtAuthGuard)
@Controller('decisions')
export class DecisionsController {
  constructor(private readonly decisionsService: DecisionsService) {}

  @Get()
  async list(@Req() req: Request) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.list();
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body(createZodValidationPipe(CreateDecisionRequestSchema)) dto: CreateDecisionRequest,
  ) {
    const { userId, spaceId } = req.user as AuthenticatedUser;
    const scopedSpaceId = requireSpaceId(spaceId);
    return this.decisionsService.create(scopedSpaceId, userId, dto);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.get(id);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(createZodValidationPipe(UpdateDecisionRequestSchema)) dto: UpdateDecisionRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    await this.decisionsService.remove(id);
  }

  @Post(':id/options')
  async createOption(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(createZodValidationPipe(CreateDecisionOptionRequestSchema)) dto: CreateDecisionOptionRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    const scopedSpaceId = requireSpaceId(spaceId);
    return this.decisionsService.createOption(id, dto, scopedSpaceId);
  }

  @Patch(':id/options/:optionId')
  async updateOption(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Body(createZodValidationPipe(UpdateDecisionOptionRequestSchema)) dto: UpdateDecisionOptionRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.updateOption(id, optionId, dto);
  }

  @Delete(':id/options/:optionId')
  @HttpCode(204)
  async removeOption(@Req() req: Request, @Param('id') id: string, @Param('optionId') optionId: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    await this.decisionsService.removeOption(id, optionId);
  }

  @Post(':id/options/:optionId/tradeoffs')
  async createTradeOff(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Body(createZodValidationPipe(CreateTradeOffItemRequestSchema)) dto: CreateTradeOffItemRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    const scopedSpaceId = requireSpaceId(spaceId);
    return this.decisionsService.createTradeOff(id, optionId, dto, scopedSpaceId);
  }

  @Patch(':id/options/:optionId/tradeoffs/:tradeoffId')
  async updateTradeOff(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Param('tradeoffId') tradeoffId: string,
    @Body(createZodValidationPipe(UpdateTradeOffItemRequestSchema)) dto: UpdateTradeOffItemRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.updateTradeOff(id, optionId, tradeoffId, dto);
  }

  @Delete(':id/options/:optionId/tradeoffs/:tradeoffId')
  @HttpCode(204)
  async removeTradeOff(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Param('tradeoffId') tradeoffId: string,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    await this.decisionsService.removeTradeOff(id, optionId, tradeoffId);
  }
}
