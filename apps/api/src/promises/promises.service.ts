import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import type {
  CreatePromiseRequest,
  PromiseResponse,
  PromiseStatus,
  ResolvePromiseRequest,
  UpdatePromiseRequest,
} from '@us-os/shared-types';
import { CryptoService, type EncryptedNote } from '../crypto/crypto.service';

type PromiseRow = Awaited<ReturnType<typeof prisma.promise.create>>;

@Injectable()
export class PromisesService {
  constructor(private readonly crypto: CryptoService) {}

  async list(): Promise<PromiseResponse[]> {
    const rows = await prisma.promise.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.toResponse(row));
  }

  async create(spaceId: string, userId: string, dto: CreatePromiseRequest): Promise<PromiseResponse> {
    const encrypted = this.encryptIfPresent(dto.note);
    const row = await prisma.promise.create({
      data: {
        spaceId,
        promisedBy: userId,
        title: dto.title,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        noteCiphertext: encrypted?.ciphertext ?? null,
        noteIv: encrypted?.iv ?? null,
        noteAuthTag: encrypted?.authTag ?? null,
        noteVersion: encrypted ? 1 : null,
      },
    });
    return this.toResponse(row);
  }

  async get(id: string): Promise<PromiseResponse> {
    const row = await this.findPromiseOrThrow(id);
    return this.toResponse(row);
  }

  async update(id: string, dto: UpdatePromiseRequest): Promise<PromiseResponse> {
    await this.findPromiseOrThrow(id);

    const data: {
      title?: string;
      dueDate?: Date | null;
      noteCiphertext?: string | null;
      noteIv?: string | null;
      noteAuthTag?: string | null;
      noteVersion?: number | null;
    } = {};

    if (dto.title !== undefined) data.title = dto.title;
    if ('dueDate' in dto) data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if ('note' in dto) {
      const encrypted = this.encryptIfPresent(dto.note);
      data.noteCiphertext = encrypted?.ciphertext ?? null;
      data.noteIv = encrypted?.iv ?? null;
      data.noteAuthTag = encrypted?.authTag ?? null;
      data.noteVersion = encrypted ? 1 : null;
    }

    const row = await prisma.promise.update({ where: { id }, data });
    return this.toResponse(row);
  }

  async resolve(id: string, resolverUserId: string, dto: ResolvePromiseRequest): Promise<PromiseResponse> {
    await this.findPromiseOrThrow(id);

    const data: {
      status: string;
      resolvedAt: Date;
      resolvedBy: string;
      noteCiphertext?: string | null;
      noteIv?: string | null;
      noteAuthTag?: string | null;
      noteVersion?: number | null;
    } = {
      status: dto.status,
      resolvedAt: new Date(),
      resolvedBy: resolverUserId,
    };

    // Replace-if-provided/leave-untouched-if-omitted, same as FR-05's
    // decide(outcomeNote) — a re-resolve without a note keeps the prior one.
    if ('note' in dto) {
      const encrypted = this.encryptIfPresent(dto.note);
      data.noteCiphertext = encrypted?.ciphertext ?? null;
      data.noteIv = encrypted?.iv ?? null;
      data.noteAuthTag = encrypted?.authTag ?? null;
      data.noteVersion = encrypted ? 1 : null;
    }

    const row = await prisma.promise.update({ where: { id }, data });
    return this.toResponse(row);
  }

  async remove(id: string): Promise<void> {
    await this.findPromiseOrThrow(id);
    await prisma.promise.delete({ where: { id } });
  }

  private async findPromiseOrThrow(id: string): Promise<PromiseRow> {
    // findFirst (not findUnique): RLS-scoping happens transparently via the
    // tenant-scoped Prisma query extension, so a row in another space is
    // invisible here, not merely forbidden — a miss always means 404, never 403.
    const row = await prisma.promise.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Promise not found');
    return row;
  }

  private encryptIfPresent(note: string | null | undefined): EncryptedNote | null {
    if (note === undefined || note === null) return null;
    const trimmed = note.trim();
    if (trimmed.length === 0) return null;
    return this.crypto.encryptNote(trimmed);
  }

  private decryptNoteField(row: PromiseRow): string | null {
    if (!row.noteCiphertext || !row.noteIv || !row.noteAuthTag) return null;
    try {
      return this.crypto.decryptNote({ ciphertext: row.noteCiphertext, iv: row.noteIv, authTag: row.noteAuthTag });
    } catch (err) {
      // A single corrupted/unreadable field must not fail the whole response —
      // same resilience pattern as FR-02's Milestone.note.
      console.error(`Failed to decrypt note for promise ${row.id}`, err);
      return null;
    }
  }

  private toResponse(row: PromiseRow): PromiseResponse {
    return {
      id: row.id,
      title: row.title,
      promisedBy: row.promisedBy,
      dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
      status: row.status as PromiseStatus,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      resolvedBy: row.resolvedBy,
      note: this.decryptNoteField(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
