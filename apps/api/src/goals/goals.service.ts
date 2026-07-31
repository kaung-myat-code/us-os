import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import type { CreateGoalRequest, UpdateGoalRequest, GoalCategory, GoalResponse, GoalStatus } from '@us-os/shared-types';
import { CryptoService, type EncryptedNote } from '../crypto/crypto.service';

type GoalRow = Awaited<ReturnType<typeof prisma.goal.create>>;

@Injectable()
export class GoalsService {
  constructor(private readonly crypto: CryptoService) {}

  async list(): Promise<GoalResponse[]> {
    const rows = await prisma.goal.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.toResponse(row));
  }

  async create(spaceId: string, userId: string, dto: CreateGoalRequest): Promise<GoalResponse> {
    const encrypted = this.encryptIfPresent(dto.description);
    const row = await prisma.goal.create({
      data: {
        spaceId,
        createdBy: userId,
        title: dto.title,
        category: dto.category ?? 'other',
        targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
        descriptionCiphertext: encrypted?.ciphertext ?? null,
        descriptionIv: encrypted?.iv ?? null,
        descriptionAuthTag: encrypted?.authTag ?? null,
        descriptionVersion: encrypted ? 1 : null,
      },
    });
    return this.toResponse(row);
  }

  async get(id: string): Promise<GoalResponse> {
    const row = await this.findGoalOrThrow(id);
    return this.toResponse(row);
  }

  async update(id: string, dto: UpdateGoalRequest): Promise<GoalResponse> {
    const existing = await this.findGoalOrThrow(id);

    const data: {
      title?: string;
      category?: string;
      targetDate?: Date | null;
      progress?: number;
      status?: string;
      achievedAt?: Date | null;
      descriptionCiphertext?: string | null;
      descriptionIv?: string | null;
      descriptionAuthTag?: string | null;
      descriptionVersion?: number | null;
    } = {};

    if (dto.title !== undefined) data.title = dto.title;
    if (dto.category !== undefined) data.category = dto.category;
    if ('targetDate' in dto) data.targetDate = dto.targetDate ? new Date(dto.targetDate) : null;
    if (dto.progress !== undefined) data.progress = dto.progress;

    if (dto.status !== undefined) {
      data.status = dto.status;
      // achievedAt tracks the status field only — set on transition into
      // 'achieved', cleared on transition out, untouched while it stays
      // 'achieved' across unrelated edits (see Step 1 of goals.controller.spec.ts).
      if (dto.status === 'achieved' && existing.status !== 'achieved') {
        data.achievedAt = new Date();
      } else if (dto.status !== 'achieved' && existing.status === 'achieved') {
        data.achievedAt = null;
      }
    }

    if ('description' in dto) {
      const encrypted = this.encryptIfPresent(dto.description);
      data.descriptionCiphertext = encrypted?.ciphertext ?? null;
      data.descriptionIv = encrypted?.iv ?? null;
      data.descriptionAuthTag = encrypted?.authTag ?? null;
      data.descriptionVersion = encrypted ? 1 : null;
    }

    const row = await prisma.goal.update({ where: { id }, data });
    return this.toResponse(row);
  }

  async remove(id: string): Promise<void> {
    await this.findGoalOrThrow(id);
    await prisma.goal.delete({ where: { id } });
  }

  private async findGoalOrThrow(id: string): Promise<GoalRow> {
    // findFirst (not findUnique): RLS-scoping happens transparently via the
    // tenant-scoped Prisma query extension, so a row in another space is
    // invisible here, not merely forbidden — a miss always means 404, never 403.
    const row = await prisma.goal.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Goal not found');
    return row;
  }

  private encryptIfPresent(description: string | null | undefined): EncryptedNote | null {
    if (description === undefined || description === null) return null;
    const trimmed = description.trim();
    if (trimmed.length === 0) return null;
    return this.crypto.encryptNote(trimmed);
  }

  private decryptDescription(row: GoalRow): string | null {
    if (!row.descriptionCiphertext || !row.descriptionIv || !row.descriptionAuthTag) return null;
    try {
      return this.crypto.decryptNote({
        ciphertext: row.descriptionCiphertext,
        iv: row.descriptionIv,
        authTag: row.descriptionAuthTag,
      });
    } catch (err) {
      // A single corrupted/unreadable field must not fail the whole response —
      // same resilience pattern as FR-02's Milestone.note.
      console.error(`Failed to decrypt description for goal ${row.id}`, err);
      return null;
    }
  }

  private toResponse(row: GoalRow): GoalResponse {
    return {
      id: row.id,
      title: row.title,
      createdBy: row.createdBy,
      category: row.category as GoalCategory,
      targetDate: row.targetDate ? row.targetDate.toISOString().slice(0, 10) : null,
      progress: row.progress,
      status: row.status as GoalStatus,
      achievedAt: row.achievedAt ? row.achievedAt.toISOString() : null,
      description: this.decryptDescription(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
