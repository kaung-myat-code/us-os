import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import type {
  CreateMilestoneRequest,
  MilestoneCategory,
  MilestoneResponse,
  UpdateMilestoneRequest,
} from '@us-os/shared-types';
import { CryptoService, type EncryptedNote } from '../crypto/crypto.service';

type MilestoneRow = Awaited<ReturnType<typeof prisma.milestone.create>>;

@Injectable()
export class MilestonesService {
  constructor(private readonly crypto: CryptoService) {}

  async list(): Promise<MilestoneResponse[]> {
    // No spaceId filter here: RLS-scoping happens transparently via the
    // tenant-scoped Prisma query extension for every find* method, so this
    // already returns only the caller's space.
    const rows = await prisma.milestone.findMany({
      orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toResponse(row));
  }

  async create(spaceId: string, userId: string, dto: CreateMilestoneRequest): Promise<MilestoneResponse> {
    const encrypted = this.encryptIfPresent(dto.note);
    const row = await prisma.milestone.create({
      data: {
        spaceId,
        createdBy: userId,
        title: dto.title,
        eventDate: new Date(dto.eventDate),
        category: dto.category,
        noteCiphertext: encrypted?.ciphertext ?? null,
        noteIv: encrypted?.iv ?? null,
        noteAuthTag: encrypted?.authTag ?? null,
        noteVersion: encrypted ? 1 : null,
      },
    });
    return this.toResponse(row);
  }

  async update(id: string, dto: UpdateMilestoneRequest): Promise<MilestoneResponse> {
    await this.findOrThrow(id);

    const data: {
      title?: string;
      eventDate?: Date;
      category?: MilestoneCategory;
      noteCiphertext?: string | null;
      noteIv?: string | null;
      noteAuthTag?: string | null;
      noteVersion?: number | null;
    } = {};

    if (dto.title !== undefined) data.title = dto.title;
    if (dto.eventDate !== undefined) data.eventDate = new Date(dto.eventDate);
    if (dto.category !== undefined) data.category = dto.category;

    if ('note' in dto) {
      const encrypted = this.encryptIfPresent(dto.note);
      data.noteCiphertext = encrypted?.ciphertext ?? null;
      data.noteIv = encrypted?.iv ?? null;
      data.noteAuthTag = encrypted?.authTag ?? null;
      data.noteVersion = encrypted ? 1 : null;
    }

    const row = await prisma.milestone.update({ where: { id }, data });
    return this.toResponse(row);
  }

  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await prisma.milestone.delete({ where: { id } });
  }

  private async findOrThrow(id: string): Promise<MilestoneRow> {
    // findFirst (not findUnique) because RLS-scoping happens transparently
    // via the tenant-scoped Prisma query extension regardless of which
    // find* method is used; a row in another space is invisible here, not
    // merely forbidden, so a miss always means 404, never 403.
    const row = await prisma.milestone.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Milestone not found');
    return row;
  }

  private encryptIfPresent(note: string | null | undefined): EncryptedNote | null {
    if (note === undefined || note === null) return null;
    const trimmed = note.trim();
    if (trimmed.length === 0) return null;
    return this.crypto.encryptNote(trimmed);
  }

  private toResponse(row: MilestoneRow): MilestoneResponse {
    let note: string | null = null;
    if (row.noteCiphertext && row.noteIv && row.noteAuthTag) {
      try {
        note = this.crypto.decryptNote({
          ciphertext: row.noteCiphertext,
          iv: row.noteIv,
          authTag: row.noteAuthTag,
        });
      } catch (err) {
        // A single corrupted/unreadable note must not fail the whole
        // GET /milestones response — surface null and log server-side.
        console.error(`Failed to decrypt note for milestone ${row.id}`, err);
        note = null;
      }
    }
    return {
      id: row.id,
      title: row.title,
      eventDate: row.eventDate.toISOString().slice(0, 10),
      category: row.category as MilestoneCategory,
      note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
