import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import type {
  CreateDecisionRequest,
  UpdateDecisionRequest,
  DecisionDetailResponse,
  DecisionListItemResponse,
  DecisionOptionResponse,
  DecisionStatus,
  TradeOffItemResponse,
  TradeOffType,
} from '@us-os/shared-types';
import { CryptoService, type EncryptedNote } from '../crypto/crypto.service';

type DecisionRow = Awaited<ReturnType<typeof prisma.decision.create>>;
type DecisionOptionRow = Awaited<ReturnType<typeof prisma.decisionOption.create>>;
type TradeOffItemRow = Awaited<ReturnType<typeof prisma.tradeOffItem.create>>;
type OptionWithTradeOffs = DecisionOptionRow & { tradeOffs: TradeOffItemRow[] };

@Injectable()
export class DecisionsService {
  constructor(private readonly crypto: CryptoService) {}

  async list(): Promise<DecisionListItemResponse[]> {
    const rows = await prisma.decision.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.toListItem(row));
  }

  async create(spaceId: string, userId: string, dto: CreateDecisionRequest): Promise<DecisionDetailResponse> {
    const encrypted = this.encryptIfPresent(dto.rationale);
    const row = await prisma.decision.create({
      data: {
        spaceId,
        createdBy: userId,
        title: dto.title,
        rationaleCiphertext: encrypted?.ciphertext ?? null,
        rationaleIv: encrypted?.iv ?? null,
        rationaleAuthTag: encrypted?.authTag ?? null,
        rationaleVersion: encrypted ? 1 : null,
      },
    });
    return this.toDetail(row, []);
  }

  async get(id: string): Promise<DecisionDetailResponse> {
    const row = await this.findDecisionOrThrow(id);
    const options = await this.loadOptionsWithTradeOffs(id);
    return this.toDetail(row, options);
  }

  async update(id: string, dto: UpdateDecisionRequest): Promise<DecisionDetailResponse> {
    await this.findDecisionOrThrow(id);

    const data: {
      title?: string;
      rationaleCiphertext?: string | null;
      rationaleIv?: string | null;
      rationaleAuthTag?: string | null;
      rationaleVersion?: number | null;
    } = {};

    if (dto.title !== undefined) data.title = dto.title;
    if ('rationale' in dto) {
      const encrypted = this.encryptIfPresent(dto.rationale);
      data.rationaleCiphertext = encrypted?.ciphertext ?? null;
      data.rationaleIv = encrypted?.iv ?? null;
      data.rationaleAuthTag = encrypted?.authTag ?? null;
      data.rationaleVersion = encrypted ? 1 : null;
    }

    const row = await prisma.decision.update({ where: { id }, data });
    const options = await this.loadOptionsWithTradeOffs(id);
    return this.toDetail(row, options);
  }

  async remove(id: string): Promise<void> {
    await this.findDecisionOrThrow(id);
    await prisma.decision.delete({ where: { id } });
  }

  // --- Helpers used by this task and extended by later tasks ---

  protected async findDecisionOrThrow(id: string): Promise<DecisionRow> {
    // findFirst (not findUnique): RLS-scoping happens transparently via the
    // tenant-scoped Prisma query extension, so a row in another space is
    // invisible here, not merely forbidden — a miss always means 404, never 403.
    const row = await prisma.decision.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Decision not found');
    return row;
  }

  protected async findOptionOrThrow(decisionId: string, optionId: string): Promise<DecisionOptionRow> {
    await this.findDecisionOrThrow(decisionId);
    const row = await prisma.decisionOption.findFirst({ where: { id: optionId, decisionId } });
    if (!row) throw new NotFoundException('Decision option not found');
    return row;
  }

  protected async loadOptionsWithTradeOffs(decisionId: string): Promise<OptionWithTradeOffs[]> {
    return prisma.decisionOption.findMany({
      where: { decisionId },
      orderBy: { createdAt: 'asc' },
      include: { tradeOffs: { orderBy: { createdAt: 'asc' } } },
    });
  }

  protected encryptIfPresent(note: string | null | undefined): EncryptedNote | null {
    if (note === undefined || note === null) return null;
    const trimmed = note.trim();
    if (trimmed.length === 0) return null;
    return this.crypto.encryptNote(trimmed);
  }

  private decryptField(
    ciphertext: string | null,
    iv: string | null,
    authTag: string | null,
    entityId: string,
    fieldName: string,
  ): string | null {
    if (!ciphertext || !iv || !authTag) return null;
    try {
      return this.crypto.decryptNote({ ciphertext, iv, authTag });
    } catch (err) {
      // A single corrupted/unreadable field must not fail the whole response —
      // same resilience pattern as FR-02's Milestone.note.
      console.error(`Failed to decrypt ${fieldName} for decision ${entityId}`, err);
      return null;
    }
  }

  protected toListItem(row: DecisionRow): DecisionListItemResponse {
    return {
      id: row.id,
      title: row.title,
      status: row.status as DecisionStatus,
      rationale: this.decryptField(row.rationaleCiphertext, row.rationaleIv, row.rationaleAuthTag, row.id, 'rationale'),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  protected toDetail(row: DecisionRow, options: OptionWithTradeOffs[]): DecisionDetailResponse {
    return {
      id: row.id,
      title: row.title,
      status: row.status as DecisionStatus,
      rationale: this.decryptField(row.rationaleCiphertext, row.rationaleIv, row.rationaleAuthTag, row.id, 'rationale'),
      outcomeNote: this.decryptField(row.outcomeCiphertext, row.outcomeIv, row.outcomeAuthTag, row.id, 'outcome'),
      chosenOptionId: row.chosenOptionId,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      options: options.map((option) => this.toOptionResponse(option, option.tradeOffs)),
    };
  }

  protected toOptionResponse(row: DecisionOptionRow, tradeOffs: TradeOffItemRow[]): DecisionOptionResponse {
    const score = tradeOffs.reduce((sum, item) => sum + (item.type === 'pro' ? item.weight : -item.weight), 0);
    return {
      id: row.id,
      label: row.label,
      score,
      tradeOffs: tradeOffs.map((item) => this.toTradeOffResponse(item)),
    };
  }

  protected toTradeOffResponse(row: TradeOffItemRow): TradeOffItemResponse {
    return { id: row.id, type: row.type as TradeOffType, label: row.label, weight: row.weight };
  }
}
