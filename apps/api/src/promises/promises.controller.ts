import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreatePromiseRequestSchema,
  ResolvePromiseRequestSchema,
  UpdatePromiseRequestSchema,
  type CreatePromiseRequest,
  type ResolvePromiseRequest,
  type UpdatePromiseRequest,
} from '@us-os/shared-types';
import type { Request } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import { requireSpaceId } from '../milestones/require-space';
import { PromisesService } from './promises.service';

@UseGuards(JwtAuthGuard)
@Controller('promises')
export class PromisesController {
  constructor(private readonly promisesService: PromisesService) {}

  @Get()
  async list(@Req() req: Request) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.promisesService.list();
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body(createZodValidationPipe(CreatePromiseRequestSchema)) dto: CreatePromiseRequest,
  ) {
    const { userId, spaceId } = req.user as AuthenticatedUser;
    const scopedSpaceId = requireSpaceId(spaceId);
    return this.promisesService.create(scopedSpaceId, userId, dto);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.promisesService.get(id);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(createZodValidationPipe(UpdatePromiseRequestSchema)) dto: UpdatePromiseRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.promisesService.update(id, dto);
  }

  @Patch(':id/resolve')
  async resolve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(createZodValidationPipe(ResolvePromiseRequestSchema)) dto: ResolvePromiseRequest,
  ) {
    const { userId, spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.promisesService.resolve(id, userId, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    await this.promisesService.remove(id);
  }
}
