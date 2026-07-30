import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import type {
  CreateDecisionRequest,
  CreateDecisionOptionRequest,
  CreateTradeOffItemRequest,
  DecideDecisionRequest,
  UpdateDecisionRequest,
  UpdateDecisionOptionRequest,
  UpdateTradeOffItemRequest,
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

const MAX_OPTIONS_PER_DECISION = 6;
const MAX_TRADEOFFS_PER_OPTION = 15;

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

  async decide(id: string, dto: DecideDecisionRequest): Promise<DecisionDetailResponse> {
    await this.findDecisionOrThrow(id);
    const option = await prisma.decisionOption.findFirst({ where: { id: dto.chosenOptionId, decisionId: id } });
    if (!option) {
      throw new BadRequestException(`Option ${dto.chosenOptionId} does not belong to decision ${id}`);
    }

    const data: {
      status: DecisionStatus;
      chosenOptionId: string;
      decidedAt: Date;
      outcomeCiphertext?: string;
      outcomeIv?: string;
      outcomeAuthTag?: string;
      outcomeVersion?: number;
    } = {
      status: 'decided',
      chosenOptionId: dto.chosenOptionId,
      decidedAt: new Date(),
    };

    if ('outcomeNote' in dto) {
      const encrypted = this.encryptIfPresent(dto.outcomeNote);
      // Only overwrite the outcome columns if a new note was actually provided
      // (non-empty after trim) — an omitted or empty outcomeNote on re-decide
      // leaves the existing outcome note untouched, per the spec's lifecycle rules.
      if (encrypted) {
        data.outcomeCiphertext = encrypted.ciphertext;
        data.outcomeIv = encrypted.iv;
        data.outcomeAuthTag = encrypted.authTag;
        data.outcomeVersion = 1;
      }
    }

    const row = await prisma.decision.update({ where: { id }, data });
    const options = await this.loadOptionsWithTradeOffs(id);
    return this.toDetail(row, options);
  }

  async reopen(id: string): Promise<DecisionDetailResponse> {
    const decision = await this.findDecisionOrThrow(id);
    if (decision.status !== 'decided') {
      throw new BadRequestException('Decision is already open');
    }
    const row = await prisma.decision.update({
      where: { id },
      data: { status: 'open', chosenOptionId: null, decidedAt: null },
    });
    const options = await this.loadOptionsWithTradeOffs(id);
    return this.toDetail(row, options);
  }

  async createOption(
    decisionId: string,
    dto: CreateDecisionOptionRequest,
    spaceId: string,
  ): Promise<DecisionOptionResponse> {
    await this.findDecisionOrThrow(decisionId);
    const count = await prisma.decisionOption.count({ where: { decisionId } });
    if (count >= MAX_OPTIONS_PER_DECISION) {
      throw new BadRequestException(
        `Decision ${decisionId} already has the maximum of ${MAX_OPTIONS_PER_DECISION} options`,
      );
    }
    const row = await prisma.decisionOption.create({ data: { spaceId, decisionId, label: dto.label } });
    return this.toOptionResponse(row, []);
  }

  async updateOption(
    decisionId: string,
    optionId: string,
    dto: UpdateDecisionOptionRequest,
  ): Promise<DecisionOptionResponse> {
    const option = await this.findOptionOrThrow(decisionId, optionId);
    const row = await prisma.decisionOption.update({ where: { id: option.id }, data: { label: dto.label } });
    const tradeOffs = await prisma.tradeOffItem.findMany({ where: { optionId }, orderBy: { createdAt: 'asc' } });
    return this.toOptionResponse(row, tradeOffs);
  }

  async removeOption(decisionId: string, optionId: string): Promise<void> {
    await this.findOptionOrThrow(decisionId, optionId);
    const referencingDecision = await prisma.decision.findFirst({ where: { chosenOptionId: optionId } });
    if (referencingDecision) {
      throw new BadRequestException(
        `Cannot delete option ${optionId} — it is the chosen option of decision ${referencingDecision.id}. Reopen the decision first.`,
      );
    }
    await prisma.decisionOption.delete({ where: { id: optionId } });
  }

  async createTradeOff(
    decisionId: string,
    optionId: string,
    dto: CreateTradeOffItemRequest,
    spaceId: string,
  ): Promise<TradeOffItemResponse> {
    await this.findOptionOrThrow(decisionId, optionId);
    const count = await prisma.tradeOffItem.count({ where: { optionId } });
    if (count >= MAX_TRADEOFFS_PER_OPTION) {
      throw new BadRequestException(
        `Option ${optionId} already has the maximum of ${MAX_TRADEOFFS_PER_OPTION} trade-off items`,
      );
    }
    const row = await prisma.tradeOffItem.create({
      data: { spaceId, optionId, type: dto.type, label: dto.label, weight: dto.weight },
    });
    return this.toTradeOffResponse(row);
  }

  async updateTradeOff(
    decisionId: string,
    optionId: string,
    tradeoffId: string,
    dto: UpdateTradeOffItemRequest,
  ): Promise<TradeOffItemResponse> {
    await this.findOptionOrThrow(decisionId, optionId);
    const tradeoff = await prisma.tradeOffItem.findFirst({ where: { id: tradeoffId, optionId } });
    if (!tradeoff) throw new NotFoundException('Trade-off item not found');

    const data: { type?: TradeOffType; label?: string; weight?: number } = {};
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.weight !== undefined) data.weight = dto.weight;

    const row = await prisma.tradeOffItem.update({ where: { id: tradeoff.id }, data });
    return this.toTradeOffResponse(row);
  }

  async removeTradeOff(decisionId: string, optionId: string, tradeoffId: string): Promise<void> {
    await this.findOptionOrThrow(decisionId, optionId);
    const tradeoff = await prisma.tradeOffItem.findFirst({ where: { id: tradeoffId, optionId } });
    if (!tradeoff) throw new NotFoundException('Trade-off item not found');
    await prisma.tradeOffItem.delete({ where: { id: tradeoff.id } });
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
