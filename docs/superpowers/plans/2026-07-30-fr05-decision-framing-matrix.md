# FR-05: Decision Framing Matrix Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partners create a `Decision`, add up to 6 weighted-pros/cons `DecisionOption`s, see a live-computed net score per option, and mark/reopen an eventual outcome — backend API plus a minimal unstyled frontend.

**Architecture:** Three new Prisma models (`Decision` → `DecisionOption` → `TradeOffItem`) each carrying a denormalized `spaceId` for uniform RLS, following FR-02's `Milestone` pattern exactly. A new `apps/api/src/decisions` NestJS module reuses FR-02's `CryptoService` for two encrypted free-text fields (`rationale`, `outcome`) and computes each option's score on every read rather than storing it. Fully nested REST routes (`/decisions/:id/options/:optionId/tradeoffs/:tradeoffId`). Minimal unstyled Next.js pages at `/decisions` and `/decisions/:id`.

**Tech Stack:** NestJS, Prisma, PostgreSQL 16 (RLS), Zod (`packages/shared-types`), Next.js App Router, Jest (`apps/api`, integration tests against real Postgres via docker-compose), Vitest (`packages/shared-types`).

## Global Constraints

- All new tables (`decisions`, `decision_options`, `trade_off_items`) carry `space_id` and get the identical `tenant_isolation` RLS policy already used on `milestones`.
- `rationale` and `outcome` are AES-256-GCM encrypted via the existing `CryptoService`; nothing else is encrypted. Ciphertext columns are never serialized in API responses.
- Score is `Σ(pro weights) − Σ(con weights)`, computed in the service layer on every read, never stored as a column.
- Soft caps: `MAX_OPTIONS_PER_DECISION = 6`, `MAX_TRADEOFFS_PER_OPTION = 15`, enforced in the service layer (not DB constraints), returning `400`.
- Authorization: no per-entry ownership; either partner may edit/delete anything in the space. A row invisible under RLS (wrong space or missing) always maps to `404`, never `403`.
- All error responses use the existing RFC 7807 `HttpExceptionFilter` — controllers/services just throw plain Nest exceptions (`NotFoundException`, `BadRequestException`), never format bodies themselves.
- No optimistic locking — last-write-wins.
- Reference spec: `docs/superpowers/specs/2026-07-30-fr05-decision-framing-matrix-design.md`.

---

## File Structure

**Create:**
- `packages/database/prisma/migrations/<timestamp>_add_decision_tables/migration.sql` — new tables + RLS
- `packages/shared-types/src/decision.ts` — Zod schemas + response types
- `packages/shared-types/src/decision.test.ts` — schema validation tests
- `apps/api/src/decisions/decisions.module.ts`
- `apps/api/src/decisions/decisions.service.ts`
- `apps/api/src/decisions/decisions.controller.ts`
- `apps/api/src/decisions/decisions.controller.spec.ts` — decision-level CRUD + lifecycle integration tests
- `apps/api/src/decisions/decisions-options.controller.spec.ts` — option/tradeoff nested-resource integration tests
- `apps/web/app/decisions/page.tsx` — list view
- `apps/web/app/decisions/[id]/page.tsx` — comparison/detail view

**Modify:**
- `packages/database/prisma/schema.prisma` — add `Decision`, `DecisionOption`, `TradeOffItem` models + back-relations on `Space`/`User`
- `packages/database/src/client.ts` — add the three new models to `TENANT_SCOPED_MODELS`
- `packages/database/src/index.ts` — export the three new Prisma types
- `packages/shared-types/src/index.ts` — export `./decision`
- `apps/api/src/app.module.ts` — register `DecisionsModule`

---

### Task 1: Database schema, migration, RLS, tenant-scoping

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/database/src/client.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/prisma/migrations/<timestamp>_add_decision_tables/migration.sql`
- Create: `packages/database/prisma/rls-decisions.integration.test.ts`

**Interfaces:**
- Produces: Prisma models `Decision`, `DecisionOption`, `TradeOffItem` (camelCase client accessors `prisma.decision`, `prisma.decisionOption`, `prisma.tradeOffItem`), all tenant-scoped (queries require `TenantContext` to be set, same as `Milestone`).

- [ ] **Step 1: Add the three models to `packages/database/prisma/schema.prisma`**

Insert after the closing `}` of the `Milestone` model (currently the last model, ending at line 83):

```prisma

model Decision {
  id                  String    @id @default(uuid()) @db.Uuid
  spaceId             String    @map("space_id") @db.Uuid
  createdBy           String    @map("created_by") @db.Uuid
  title               String
  status              String    @default("open")
  chosenOptionId      String?   @map("chosen_option_id") @db.Uuid
  decidedAt           DateTime? @map("decided_at")
  rationaleCiphertext String?   @map("rationale_ciphertext")
  rationaleIv         String?   @map("rationale_iv")
  rationaleAuthTag    String?   @map("rationale_auth_tag")
  rationaleVersion    Int?      @map("rationale_version") @default(1)
  outcomeCiphertext   String?   @map("outcome_ciphertext")
  outcomeIv           String?   @map("outcome_iv")
  outcomeAuthTag      String?   @map("outcome_auth_tag")
  outcomeVersion      Int?      @map("outcome_version") @default(1)
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  space        Space           @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  creator      User            @relation(fields: [createdBy], references: [id])
  options      DecisionOption[]
  chosenOption DecisionOption? @relation("ChosenOption", fields: [chosenOptionId], references: [id])

  @@index([spaceId])
  @@map("decisions")
}

model DecisionOption {
  id         String   @id @default(uuid()) @db.Uuid
  spaceId    String   @map("space_id") @db.Uuid
  decisionId String   @map("decision_id") @db.Uuid
  label      String
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  decision  Decision       @relation(fields: [decisionId], references: [id], onDelete: Cascade)
  space     Space          @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  tradeOffs TradeOffItem[]
  chosenBy  Decision[]     @relation("ChosenOption")

  @@index([decisionId])
  @@index([spaceId])
  @@map("decision_options")
}

model TradeOffItem {
  id        String   @id @default(uuid()) @db.Uuid
  spaceId   String   @map("space_id") @db.Uuid
  optionId  String   @map("option_id") @db.Uuid
  type      String
  label     String
  weight    Int
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  option DecisionOption @relation(fields: [optionId], references: [id], onDelete: Cascade)
  space  Space          @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  @@index([optionId])
  @@index([spaceId])
  @@map("trade_off_items")
}
```

Also add back-relations. In `model Space`, after the `pairingCodes PairingCode[]` line, add:

```prisma
  decisions       Decision[]
  decisionOptions DecisionOption[]
  tradeOffItems   TradeOffItem[]
```

In `model User`, after the `createdMilestones Milestone[]` line, add:

```prisma
  createdDecisions Decision[]
```

- [ ] **Step 2: Generate the migration (schema-only, don't apply yet)**

Run: `pnpm --filter @us-os/database exec prisma migrate dev --name add_decision_tables --create-only --skip-generate`

This writes `packages/database/prisma/migrations/<timestamp>_add_decision_tables/migration.sql` from the schema diff, without applying it — so the RLS statements can be hand-appended before it runs (same two-step process implied by the RLS section in the initial `add_space_and_milestone` migration).

- [ ] **Step 3: Verify/replace the generated migration content**

Open the generated file and ensure it matches this exactly (Prisma's column/FK ordering may differ slightly — reconcile to this if so, since the RLS block appended in Step 4 depends on all three tables and their FKs existing first):

```sql
-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "chosen_option_id" UUID,
    "decided_at" TIMESTAMP(3),
    "rationale_ciphertext" TEXT,
    "rationale_iv" TEXT,
    "rationale_auth_tag" TEXT,
    "rationale_version" INTEGER DEFAULT 1,
    "outcome_ciphertext" TEXT,
    "outcome_iv" TEXT,
    "outcome_auth_tag" TEXT,
    "outcome_version" INTEGER DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_options" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decision_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_off_items" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_off_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_space_id_idx" ON "decisions"("space_id");

-- CreateIndex
CREATE INDEX "decision_options_decision_id_idx" ON "decision_options"("decision_id");

-- CreateIndex
CREATE INDEX "decision_options_space_id_idx" ON "decision_options"("space_id");

-- CreateIndex
CREATE INDEX "trade_off_items_option_id_idx" ON "trade_off_items"("option_id");

-- CreateIndex
CREATE INDEX "trade_off_items_space_id_idx" ON "trade_off_items"("space_id");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_off_items" ADD CONSTRAINT "trade_off_items_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "decision_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_off_items" ADD CONSTRAINT "trade_off_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_chosen_option_id_fkey" FOREIGN KEY ("chosen_option_id") REFERENCES "decision_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: tenant isolation on decisions, decision_options, trade_off_items
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "decisions"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

ALTER TABLE "decision_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_options" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "decision_options"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

ALTER TABLE "trade_off_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trade_off_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "trade_off_items"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);
```

Note: `decisions_chosen_option_id_fkey` is intentionally the last `AddForeignKey` — `decision_options` must exist before it can be referenced. The RLS block is appended last (Prisma never generates it; it's carried over from the `add_space_and_milestone` precedent). No explicit `GRANT` is needed for `us_os_app` — the `add_restricted_app_role` migration's `ALTER DEFAULT PRIVILEGES` already covers new tables.

- [ ] **Step 4: Apply the migration and regenerate the Prisma client**

Run: `pnpm db:migrate` (applies pending migrations, prompts for confirmation if run interactively — accept), then `pnpm db:generate`.

- [ ] **Step 5: Wire the new models into tenant-scoping (`packages/database/src/client.ts`)**

Change line 17:

```diff
-const TENANT_SCOPED_MODELS = new Set(['Milestone']);
+const TENANT_SCOPED_MODELS = new Set(['Milestone', 'Decision', 'DecisionOption', 'TradeOffItem']);
```

Change line 37's type cast to include the new camelCase model names:

```diff
-      const camelModel = (model.charAt(0).toLowerCase() + model.slice(1)) as 'milestone';
+      const camelModel = (model.charAt(0).toLowerCase() + model.slice(1)) as
+        | 'milestone'
+        | 'decision'
+        | 'decisionOption'
+        | 'tradeOffItem';
```

- [ ] **Step 6: Export the new Prisma types (`packages/database/src/index.ts`)**

```diff
-export type { Space, User, SpaceMembership, PairingCode, Milestone } from '@prisma/client';
+export type { Space, User, SpaceMembership, PairingCode, Milestone, Decision, DecisionOption, TradeOffItem } from '@prisma/client';
```

- [ ] **Step 7: Write the RLS isolation test (`packages/database/prisma/rls-decisions.integration.test.ts`)**

This validates the denormalized-`spaceId` architecture directly on the child tables, not only through a `Decision` join — the single most important test for this schema decision.

```typescript
import { prisma } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation on decision tables (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };
  let userA: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Decisions Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Decisions Space B' } });
    userA = await prisma.user.create({
      data: { email: `rls-decisions-a-${Date.now()}@example.com`, passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.$disconnect();
  });

  it('isolates decisions, options, and trade-off items between spaces, queried directly on each table', async () => {
    const decisionA = await TenantContext.run(spaceA.id, () =>
      prisma.decision.create({ data: { spaceId: spaceA.id, createdBy: userA.id, title: 'A decision' } }),
    );
    const optionA = await TenantContext.run(spaceA.id, () =>
      prisma.decisionOption.create({ data: { spaceId: spaceA.id, decisionId: decisionA.id, label: 'A option' } }),
    );
    await TenantContext.run(spaceA.id, () =>
      prisma.tradeOffItem.create({
        data: { spaceId: spaceA.id, optionId: optionA.id, type: 'pro', label: 'A pro', weight: 3 },
      }),
    );

    // Direct queries from space B's context must see none of space A's rows,
    // on every one of the three tables — not just the top-level Decision.
    const decisionsFromB = await TenantContext.run(spaceB.id, () => prisma.decision.findMany());
    const optionsFromB = await TenantContext.run(spaceB.id, () => prisma.decisionOption.findMany());
    const tradeOffsFromB = await TenantContext.run(spaceB.id, () => prisma.tradeOffItem.findMany());

    expect(decisionsFromB).toEqual([]);
    expect(optionsFromB).toEqual([]);
    expect(tradeOffsFromB).toEqual([]);

    // And space A's own context still sees them.
    const decisionsFromA = await TenantContext.run(spaceA.id, () => prisma.decision.findMany());
    expect(decisionsFromA.map((d) => d.id)).toEqual([decisionA.id]);
  });
});
```

- [ ] **Step 8: Run the new test to verify it passes**

Run: `pnpm --filter @us-os/database test` (or the project's configured test runner for `packages/database` — check `packages/database/package.json` `test` script; if none exists yet, run via `jest packages/database/prisma/rls-decisions.integration.test.ts` from repo root, matching how `rls.integration.test.ts` is already run).

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/database
git commit -m "feat: add Decision/DecisionOption/TradeOffItem schema with RLS"
```

---

### Task 2: Shared-types Zod schemas and response types

**Files:**
- Create: `packages/shared-types/src/decision.ts`
- Create: `packages/shared-types/src/decision.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `DecisionStatusSchema`/`DecisionStatus`, `TradeOffTypeSchema`/`TradeOffType`, `CreateDecisionRequestSchema`/`CreateDecisionRequest`, `UpdateDecisionRequestSchema`/`UpdateDecisionRequest`, `DecideDecisionRequestSchema`/`DecideDecisionRequest`, `CreateDecisionOptionRequestSchema`/`CreateDecisionOptionRequest`, `UpdateDecisionOptionRequestSchema`/`UpdateDecisionOptionRequest`, `CreateTradeOffItemRequestSchema`/`CreateTradeOffItemRequest`, `UpdateTradeOffItemRequestSchema`/`UpdateTradeOffItemRequest`, `TradeOffItemResponse`, `DecisionOptionResponse`, `DecisionListItemResponse`, `DecisionDetailResponse` — all consumed by Task 3-6's controller/service.

- [ ] **Step 1: Write the schema validation tests (`packages/shared-types/src/decision.test.ts`)**

```typescript
import { describe, expect, it } from 'vitest';
import {
  CreateDecisionRequestSchema,
  UpdateDecisionRequestSchema,
  DecideDecisionRequestSchema,
  CreateDecisionOptionRequestSchema,
  CreateTradeOffItemRequestSchema,
  UpdateTradeOffItemRequestSchema,
  TradeOffTypeSchema,
} from './decision';

describe('TradeOffTypeSchema', () => {
  it('accepts pro and con', () => {
    expect(TradeOffTypeSchema.safeParse('pro').success).toBe(true);
    expect(TradeOffTypeSchema.safeParse('con').success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(TradeOffTypeSchema.safeParse('neutral').success).toBe(false);
  });
});

describe('CreateDecisionRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: 'Where should we live?' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 characters', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects a rationale over 10000 characters', () => {
    expect(
      CreateDecisionRequestSchema.safeParse({ title: 'x', rationale: 'a'.repeat(10001) }).success,
    ).toBe(false);
  });

  it('accepts an explicit null rationale', () => {
    expect(CreateDecisionRequestSchema.safeParse({ title: 'x', rationale: null }).success).toBe(true);
  });
});

describe('UpdateDecisionRequestSchema', () => {
  it('distinguishes an absent rationale key from an explicit null', () => {
    const omitted = UpdateDecisionRequestSchema.parse({ title: 'x' });
    const explicit = UpdateDecisionRequestSchema.parse({ title: 'x', rationale: null });
    expect('rationale' in omitted).toBe(false);
    expect('rationale' in explicit).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(UpdateDecisionRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('DecideDecisionRequestSchema', () => {
  it('requires chosenOptionId to be a uuid', () => {
    expect(DecideDecisionRequestSchema.safeParse({ chosenOptionId: 'not-a-uuid' }).success).toBe(false);
    expect(
      DecideDecisionRequestSchema.safeParse({ chosenOptionId: '11111111-1111-1111-1111-111111111111' }).success,
    ).toBe(true);
  });

  it('rejects a missing chosenOptionId', () => {
    expect(DecideDecisionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an optional outcomeNote', () => {
    expect(
      DecideDecisionRequestSchema.safeParse({
        chosenOptionId: '11111111-1111-1111-1111-111111111111',
        outcomeNote: 'We chose Austin',
      }).success,
    ).toBe(true);
  });
});

describe('CreateDecisionOptionRequestSchema', () => {
  it('rejects an empty label', () => {
    expect(CreateDecisionOptionRequestSchema.safeParse({ label: '' }).success).toBe(false);
  });
});

describe('CreateTradeOffItemRequestSchema', () => {
  it('accepts a weight between 1 and 5', () => {
    for (const weight of [1, 3, 5]) {
      expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight }).success).toBe(true);
    }
  });

  it('rejects a weight outside 1-5', () => {
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight: 0 }).success).toBe(false);
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight: 6 }).success).toBe(false);
  });

  it('rejects a non-integer weight', () => {
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'pro', label: 'x', weight: 2.5 }).success).toBe(false);
  });

  it('rejects an invalid type', () => {
    expect(CreateTradeOffItemRequestSchema.safeParse({ type: 'neutral', label: 'x', weight: 3 }).success).toBe(false);
  });
});

describe('UpdateTradeOffItemRequestSchema', () => {
  it('accepts a partial update with only weight', () => {
    expect(UpdateTradeOffItemRequestSchema.safeParse({ weight: 4 }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(UpdateTradeOffItemRequestSchema.safeParse({}).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (module doesn't exist yet)**

Run: `pnpm --filter @us-os/shared-types test`
Expected: FAIL with a module-resolution error for `./decision`.

- [ ] **Step 3: Write `packages/shared-types/src/decision.ts`**

```typescript
import { z } from 'zod';

export const DecisionStatusSchema = z.enum(['open', 'decided']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const TradeOffTypeSchema = z.enum(['pro', 'con']);
export type TradeOffType = z.infer<typeof TradeOffTypeSchema>;

export const CreateDecisionRequestSchema = z.object({
  title: z.string().min(1).max(200),
  rationale: z.string().max(10000).nullable().optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequestSchema>;

export const UpdateDecisionRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  rationale: z.string().max(10000).nullable().optional(),
});
export type UpdateDecisionRequest = z.infer<typeof UpdateDecisionRequestSchema>;

export const DecideDecisionRequestSchema = z.object({
  chosenOptionId: z.string().uuid(),
  outcomeNote: z.string().max(10000).nullable().optional(),
});
export type DecideDecisionRequest = z.infer<typeof DecideDecisionRequestSchema>;

export const CreateDecisionOptionRequestSchema = z.object({
  label: z.string().min(1).max(200),
});
export type CreateDecisionOptionRequest = z.infer<typeof CreateDecisionOptionRequestSchema>;

export const UpdateDecisionOptionRequestSchema = z.object({
  label: z.string().min(1).max(200),
});
export type UpdateDecisionOptionRequest = z.infer<typeof UpdateDecisionOptionRequestSchema>;

export const CreateTradeOffItemRequestSchema = z.object({
  type: TradeOffTypeSchema,
  label: z.string().min(1).max(300),
  weight: z.number().int().min(1).max(5),
});
export type CreateTradeOffItemRequest = z.infer<typeof CreateTradeOffItemRequestSchema>;

export const UpdateTradeOffItemRequestSchema = z.object({
  type: TradeOffTypeSchema.optional(),
  label: z.string().min(1).max(300).optional(),
  weight: z.number().int().min(1).max(5).optional(),
});
export type UpdateTradeOffItemRequest = z.infer<typeof UpdateTradeOffItemRequestSchema>;

export interface TradeOffItemResponse {
  id: string;
  type: TradeOffType;
  label: string;
  weight: number;
}

export interface DecisionOptionResponse {
  id: string;
  label: string;
  score: number;
  tradeOffs: TradeOffItemResponse[];
}

export interface DecisionListItemResponse {
  id: string;
  title: string;
  status: DecisionStatus;
  rationale: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionDetailResponse {
  id: string;
  title: string;
  status: DecisionStatus;
  rationale: string | null;
  outcomeNote: string | null;
  chosenOptionId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  options: DecisionOptionResponse[];
}
```

- [ ] **Step 4: Export it from the package index**

```diff
 export * from './health';
 export * from './auth';
 export * from './space';
 export * from './milestone';
+export * from './decision';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/shared-types test`
Expected: PASS, all cases green.

- [ ] **Step 6: Typecheck the package**

Run: `pnpm --filter @us-os/shared-types typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types
git commit -m "feat: add Decision Zod schemas and response types to shared-types"
```

---

### Task 3: Decision-level CRUD (service + controller + module)

**Files:**
- Create: `apps/api/src/decisions/decisions.module.ts`
- Create: `apps/api/src/decisions/decisions.service.ts`
- Create: `apps/api/src/decisions/decisions.controller.ts`
- Create: `apps/api/src/decisions/decisions.controller.spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `CryptoService.encryptNote(plaintext): EncryptedNote` / `.decryptNote(EncryptedNote): string` (`apps/api/src/crypto/crypto.service.ts`); `createZodValidationPipe(schema)` (`apps/api/src/common/zod-validation.pipe.ts`); `requireSpaceId(spaceId): string` (`apps/api/src/milestones/require-space.ts`); `AuthenticatedUser` (`apps/api/src/auth/types.ts`); shared-types schemas/types from Task 2.
- Produces: `DecisionsService` with `list()`, `create()`, `get()`, `update()`, `remove()` (options/tradeoffs/lifecycle methods added in Tasks 4-6 on the same class) — all consumed by `DecisionsController` in this task and extended by later tasks' controller methods on the same file.

This task implements only the top-level `/decisions` and `/decisions/:id` routes (no nested options/tradeoffs yet — `get()`'s `options` array will just be empty until Task 4 exists, which is fine since nothing creates options yet).

- [ ] **Step 1: Write the failing integration tests (`apps/api/src/decisions/decisions.controller.spec.ts`)**

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma, TenantContext } from '@us-os/database';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { SpacesModule } from '../spaces/spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { DecisionsModule } from './decisions.module';

describe('DecisionsController — decision CRUD (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, DecisionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    const tenantMiddleware = new TenantMiddleware(moduleRef.get(SessionService));
    app.use((req: Request, res: Response, next: NextFunction) => tenantMiddleware.use(req, res, next));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: createdEmails } },
      include: { memberships: true },
    });
    const spaceIds = users.flatMap((user) => user.memberships.map((membership) => membership.spaceId));
    await prisma.space.deleteMany({ where: { id: { in: spaceIds } } });
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerWithSpace(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `decisions-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const registerCookie = registerRes.headers['set-cookie'] as unknown as string[];

    const spaceRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', registerCookie)
      .send({ name: `${label} space` });
    const spaceCookie = spaceRes.headers['set-cookie'] as unknown as string[];

    return { cookie: spaceCookie, email };
  }

  it('creates a decision without a rationale', async () => {
    const { cookie } = await registerWithSpace('create-basic');

    const res = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Where should we live?' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Where should we live?');
    expect(res.body.status).toBe('open');
    expect(res.body.rationale).toBeNull();
    expect(res.body.options).toEqual([]);
  });

  it('round-trips a rationale and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('rationale-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Job offer', rationale: "We're outgrowing our apartment" });

    expect(created.body.rationale).toBe("We're outgrowing our apartment");

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () =>
      prisma.decision.findFirstOrThrow({ where: { id: created.body.id } }),
    );
    expect(rawRow.rationaleCiphertext).not.toBeNull();
    expect(rawRow.rationaleCiphertext).not.toContain("We're outgrowing our apartment");
  });

  it('lists decisions without a nested options field or outcomeNote', async () => {
    const { cookie } = await registerWithSpace('list-shape');

    await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Decision X', rationale: 'context' });

    const res = await request(app.getHttpServer()).get('/decisions').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body[0].title).toBe('Decision X');
    expect(res.body[0].rationale).toBe('context');
    expect('options' in res.body[0]).toBe(false);
    expect('outcomeNote' in res.body[0]).toBe(false);
  });

  it('excludes another space’s decisions from the list (RLS)', async () => {
    const { cookie: cookieA } = await registerWithSpace('rls-list-a');
    const { cookie: cookieB } = await registerWithSpace('rls-list-b');

    await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookieA)
      .send({ title: 'Space A decision' });

    const res = await request(app.getHttpServer()).get('/decisions').set('Cookie', cookieB);
    expect(res.body.map((d: { title: string }) => d.title)).not.toContain('Space A decision');
  });

  it('gets a decision detail with an empty options array', async () => {
    const { cookie } = await registerWithSpace('get-detail');
    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Detail test' });

    const res = await request(app.getHttpServer()).get(`/decisions/${created.body.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual([]);
    expect(res.body.outcomeNote).toBeNull();
    expect(res.body.chosenOptionId).toBeNull();
  });

  it('updates a decision title and rationale', async () => {
    const { cookie } = await registerWithSpace('update-basic');
    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Original' });

    const res = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Updated', rationale: 'new context' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
    expect(res.body.rationale).toBe('new context');
  });

  it('deletes a decision', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'To delete' });

    const deleteRes = await request(app.getHttpServer()).delete(`/decisions/${created.body.id}`).set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/decisions').set('Cookie', cookie);
    expect(listRes.body.map((d: { id: string }) => d.id)).not.toContain(created.body.id);
  });

  it('either partner in the space may edit and delete a decision the other created', async () => {
    const creator = await registerWithSpace('either-partner-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `decisions-either-partner-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(joinerEmail);
    const joinerRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: joinerEmail, password: 'supersecret' });
    const joinerRegisterCookie = joinerRegister.headers['set-cookie'] as unknown as string[];
    const joinerRedeem = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', joinerRegisterCookie)
      .send({ code: codeRes.body.code });
    const joinerCookie = joinerRedeem.headers['set-cookie'] as unknown as string[];

    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator decision' });

    const editByJoiner = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}`)
      .set('Cookie', joinerCookie)
      .send({ title: 'Edited by joiner' });
    expect(editByJoiner.status).toBe(200);

    const deleteByJoiner = await request(app.getHttpServer())
      .delete(`/decisions/${created.body.id}`)
      .set('Cookie', joinerCookie);
    expect(deleteByJoiner.status).toBe(204);
  });

  it('returns 404 (not 403) when getting, updating, or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookieA)
      .send({ title: 'Space A decision' });

    const getRes = await request(app.getHttpServer()).get(`/decisions/${created.body.id}`).set('Cookie', cookieB);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer()).delete(`/decisions/${created.body.id}`).set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: '' });
    expect(emptyTitle.status).toBe(400);

    const titleTooLong = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'a'.repeat(201) });
    expect(titleTooLong.status).toBe(400);

    const rationaleTooLong = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'x', rationale: 'a'.repeat(10001) });
    expect(rationaleTooLong.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all decision-level endpoints', async () => {
    const getRes = await request(app.getHttpServer()).get('/decisions');
    const postRes = await request(app.getHttpServer()).post('/decisions').send({ title: 'x' });
    const patchRes = await request(app.getHttpServer()).patch('/decisions/00000000-0000-0000-0000-000000000000').send({});
    const deleteRes = await request(app.getHttpServer()).delete('/decisions/00000000-0000-0000-0000-000000000000');

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- decisions.controller.spec.ts`
Expected: FAIL — `Cannot find module './decisions.module'`.

- [ ] **Step 3: Write `apps/api/src/decisions/decisions.service.ts`**

```typescript
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
```

Note: methods are `protected`/instance methods on the same class rather than split across files — Tasks 4-6 add methods to this same file (`createOption`, `createTradeOff`, `decide`, `reopen`, etc.), matching FR-02's single-service-per-module precedent. `BadRequestException` is imported now because Task 4 uses it in the same file.

- [ ] **Step 4: Write `apps/api/src/decisions/decisions.controller.ts`**

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreateDecisionRequestSchema,
  UpdateDecisionRequestSchema,
  type CreateDecisionRequest,
  type UpdateDecisionRequest,
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
}
```

- [ ] **Step 5: Write `apps/api/src/decisions/decisions.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [DecisionsController],
  providers: [DecisionsService],
})
export class DecisionsModule {}
```

- [ ] **Step 6: Register the module in `apps/api/src/app.module.ts`**

```diff
 import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
 import cookieParser from 'cookie-parser';
 import { AuthModule } from './auth/auth.module';
+import { DecisionsModule } from './decisions/decisions.module';
 import { HealthController } from './health/health.controller';
 import { MilestonesModule } from './milestones/milestones.module';
 import { SessionModule } from './session/session.module';
 import { SpacesModule } from './spaces/spaces.module';
 import { TenantMiddleware } from './tenant/tenant.middleware';

 @Module({
-  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule],
+  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule, DecisionsModule],
   controllers: [HealthController],
   providers: [],
 })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/api test -- decisions.controller.spec.ts`
Expected: PASS, all cases green. (Requires the docker-compose Postgres to be running — same precondition as the existing `milestones.controller.spec.ts`.)

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @us-os/api typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/decisions apps/api/src/app.module.ts
git commit -m "feat: add Decision CRUD service, controller, and module"
```

---

### Task 4: Option CRUD with soft cap

**Files:**
- Modify: `apps/api/src/decisions/decisions.service.ts`
- Modify: `apps/api/src/decisions/decisions.controller.ts`
- Create: `apps/api/src/decisions/decisions-options.controller.spec.ts`

**Interfaces:**
- Consumes: `DecisionsService.findDecisionOrThrow`, `.findOptionOrThrow`, `.toOptionResponse` (protected methods already defined in Task 3, same class).
- Produces: `DecisionsService.createOption(decisionId, dto, spaceId): Promise<DecisionOptionResponse>`, `.updateOption(decisionId, optionId, dto): Promise<DecisionOptionResponse>`, `.removeOption(decisionId, optionId): Promise<void>` — consumed by this task's controller routes and by Task 6's deletion-guard tests.

- [ ] **Step 1: Write the failing integration tests (`apps/api/src/decisions/decisions-options.controller.spec.ts`)**

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { SpacesModule } from '../spaces/spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { DecisionsModule } from './decisions.module';

describe('DecisionsController — options and tradeoffs (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, DecisionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    const tenantMiddleware = new TenantMiddleware(moduleRef.get(SessionService));
    app.use((req: Request, res: Response, next: NextFunction) => tenantMiddleware.use(req, res, next));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: createdEmails } },
      include: { memberships: true },
    });
    const spaceIds = users.flatMap((user) => user.memberships.map((membership) => membership.spaceId));
    await prisma.space.deleteMany({ where: { id: { in: spaceIds } } });
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerWithSpace(label: string): Promise<{ cookie: string[] }> {
    const email = `decisions-opt-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const registerCookie = registerRes.headers['set-cookie'] as unknown as string[];
    const spaceRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', registerCookie)
      .send({ name: `${label} space` });
    const spaceCookie = spaceRes.headers['set-cookie'] as unknown as string[];
    return { cookie: spaceCookie };
  }

  async function createDecision(cookie: string[], title = 'Decision'): Promise<string> {
    const res = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title });
    return res.body.id as string;
  }

  it('creates an option under a decision', async () => {
    const { cookie } = await registerWithSpace('create-option');
    const decisionId = await createDecision(cookie);

    const res = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });

    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Austin');
    expect(res.body.score).toBe(0);
    expect(res.body.tradeOffs).toEqual([]);
  });

  it('updates an option label', async () => {
    const { cookie } = await registerWithSpace('update-option');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Original' });

    const res = await request(app.getHttpServer())
      .patch(`/decisions/${decisionId}/options/${optionRes.body.id}`)
      .set('Cookie', cookie)
      .send({ label: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Updated');
  });

  it('deletes an option', async () => {
    const { cookie } = await registerWithSpace('delete-option');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'To delete' });

    const deleteRes = await request(app.getHttpServer())
      .delete(`/decisions/${decisionId}/options/${optionRes.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const detailRes = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailRes.body.options).toEqual([]);
  });

  it('rejects a 7th option with 400 (MAX_OPTIONS_PER_DECISION = 6)', async () => {
    const { cookie } = await registerWithSpace('option-cap');
    const decisionId = await createDecision(cookie);

    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer())
        .post(`/decisions/${decisionId}/options`)
        .set('Cookie', cookie)
        .send({ label: `Option ${i}` });
      expect(res.status).toBe(201);
    }

    const seventh = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'One too many' });
    expect(seventh.status).toBe(400);
  });

  it('rejects an empty option label with 400', async () => {
    const { cookie } = await registerWithSpace('option-validation');
    const decisionId = await createDecision(cookie);

    const res = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: '' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when creating an option under a decision belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-option-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-option-b');
    const decisionId = await createDecision(cookieA);

    const res = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookieB)
      .send({ label: 'Sneaky' });
    expect(res.status).toBe(404);
  });

  it('creates, updates, and deletes a trade-off item, with score reflected in decision detail', async () => {
    const { cookie } = await registerWithSpace('tradeoff-crud');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    const optionId = optionRes.body.id as string;

    const proRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: 'Job market', weight: 5 });
    expect(proRes.status).toBe(201);

    const conRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'con', label: 'Far from family', weight: 3 });
    expect(conRes.status).toBe(201);

    const detailAfterCreate = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailAfterCreate.body.options[0].score).toBe(2); // 5 - 3

    const updateRes = await request(app.getHttpServer())
      .patch(`/decisions/${decisionId}/options/${optionId}/tradeoffs/${conRes.body.id}`)
      .set('Cookie', cookie)
      .send({ weight: 1 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.weight).toBe(1);

    const detailAfterUpdate = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailAfterUpdate.body.options[0].score).toBe(4); // 5 - 1

    const deleteRes = await request(app.getHttpServer())
      .delete(`/decisions/${decisionId}/options/${optionId}/tradeoffs/${conRes.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const detailAfterDelete = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailAfterDelete.body.options[0].score).toBe(5); // pro only
  });

  it('rejects a 16th trade-off item with 400 (MAX_TRADEOFFS_PER_OPTION = 15)', async () => {
    const { cookie } = await registerWithSpace('tradeoff-cap');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    const optionId = optionRes.body.id as string;

    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer())
        .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
        .set('Cookie', cookie)
        .send({ type: 'pro', label: `Pro ${i}`, weight: 1 });
      expect(res.status).toBe(201);
    }

    const sixteenth = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: 'One too many', weight: 1 });
    expect(sixteenth.status).toBe(400);
  });

  it('rejects invalid trade-off payloads with 400', async () => {
    const { cookie } = await registerWithSpace('tradeoff-validation');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    const optionId = optionRes.body.id as string;

    const badType = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'neutral', label: 'x', weight: 3 });
    expect(badType.status).toBe(400);

    const badWeight = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: 'x', weight: 6 });
    expect(badWeight.status).toBe(400);

    const emptyLabel = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: '', weight: 3 });
    expect(emptyLabel.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- decisions-options.controller.spec.ts`
Expected: FAIL — `POST /decisions/:id/options` returns 404 (route doesn't exist).

- [ ] **Step 3: Add option and trade-off CRUD methods to `apps/api/src/decisions/decisions.service.ts`**

Add these constants above the `@Injectable()` class declaration:

```typescript
const MAX_OPTIONS_PER_DECISION = 6;
const MAX_TRADEOFFS_PER_OPTION = 15;
```

Add these methods inside the `DecisionsService` class (after `remove()`, before the `// --- Helpers` comment):

```typescript
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
```

Add the new imports to the top of the file:

```diff
 import type {
   CreateDecisionRequest,
+  CreateDecisionOptionRequest,
+  CreateTradeOffItemRequest,
   UpdateDecisionRequest,
+  UpdateDecisionOptionRequest,
+  UpdateTradeOffItemRequest,
   DecisionDetailResponse,
   DecisionListItemResponse,
   DecisionOptionResponse,
   DecisionStatus,
   TradeOffItemResponse,
   TradeOffType,
 } from '@us-os/shared-types';
```

- [ ] **Step 4: Add the nested routes to `apps/api/src/decisions/decisions.controller.ts`**

Add the new imports:

```diff
 import {
   CreateDecisionRequestSchema,
+  CreateDecisionOptionRequestSchema,
+  CreateTradeOffItemRequestSchema,
   UpdateDecisionRequestSchema,
+  UpdateDecisionOptionRequestSchema,
+  UpdateTradeOffItemRequestSchema,
   type CreateDecisionRequest,
+  type CreateDecisionOptionRequest,
+  type CreateTradeOffItemRequest,
   type UpdateDecisionRequest,
+  type UpdateDecisionOptionRequest,
+  type UpdateTradeOffItemRequest,
 } from '@us-os/shared-types';
```

Add these methods inside the `DecisionsController` class (after `remove()`):

```typescript
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/api test -- decisions-options.controller.spec.ts`
Expected: PASS, all cases green.

- [ ] **Step 6: Run the full decisions test suite and typecheck to confirm no regressions**

Run: `pnpm --filter @us-os/api test -- decisions` then `pnpm --filter @us-os/api typecheck`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/decisions
git commit -m "feat: add option and trade-off item CRUD with soft caps and score computation"
```

---

### Task 5: Lifecycle — decide and reopen

**Files:**
- Modify: `apps/api/src/decisions/decisions.service.ts`
- Modify: `apps/api/src/decisions/decisions.controller.ts`
- Modify: `apps/api/src/decisions/decisions.controller.spec.ts`

**Interfaces:**
- Consumes: `DecisionsService.findDecisionOrThrow`, `.loadOptionsWithTradeOffs`, `.encryptIfPresent`, `.toDetail` (from Task 3, same class).
- Produces: `DecisionsService.decide(id, dto): Promise<DecisionDetailResponse>`, `.reopen(id): Promise<DecisionDetailResponse>`.

- [ ] **Step 1: Add the failing lifecycle tests to `apps/api/src/decisions/decisions.controller.spec.ts`**

Add these `it` blocks at the end of the existing `describe` block, before the final closing `});`:

```typescript
  it('decides a decision: sets status, chosenOptionId, decidedAt, and encrypts the outcome note', async () => {
    const { cookie } = await registerWithSpace('decide-basic');
    const created = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'x' });
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${created.body.id}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });

    const res = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionRes.body.id, outcomeNote: 'Chose Austin for the job market' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('decided');
    expect(res.body.chosenOptionId).toBe(optionRes.body.id);
    expect(res.body.decidedAt).not.toBeNull();
    expect(res.body.outcomeNote).toBe('Chose Austin for the job market');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () =>
      prisma.decision.findFirstOrThrow({ where: { id: created.body.id } }),
    );
    expect(rawRow.outcomeCiphertext).not.toBeNull();
    expect(rawRow.outcomeCiphertext).not.toContain('Chose Austin');
  });

  it('rejects deciding with a chosenOptionId belonging to a different decision', async () => {
    const { cookie } = await registerWithSpace('decide-wrong-option');
    const decisionA = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'A' });
    const decisionB = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'B' });
    const optionOnB = await request(app.getHttpServer())
      .post(`/decisions/${decisionB.body.id}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Option on B' });

    const res = await request(app.getHttpServer())
      .patch(`/decisions/${decisionA.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionOnB.body.id });
    expect(res.status).toBe(400);
  });

  it('re-decides an already-decided decision: omitting outcomeNote preserves the existing one, providing a new one replaces it', async () => {
    const { cookie } = await registerWithSpace('re-decide');
    const created = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'x' });
    const optionA = await request(app.getHttpServer())
      .post(`/decisions/${created.body.id}/options`)
      .set('Cookie', cookie)
      .send({ label: 'A' });
    const optionB = await request(app.getHttpServer())
      .post(`/decisions/${created.body.id}/options`)
      .set('Cookie', cookie)
      .send({ label: 'B' });

    await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionA.body.id, outcomeNote: 'First choice' });

    const redecideNoNote = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionB.body.id });
    expect(redecideNoNote.body.chosenOptionId).toBe(optionB.body.id);
    expect(redecideNoNote.body.outcomeNote).toBe('First choice');

    const redecideWithNote = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionA.body.id, outcomeNote: 'Changed our mind again' });
    expect(redecideWithNote.body.outcomeNote).toBe('Changed our mind again');
  });

  it('reopens a decided decision, clearing status/chosenOptionId/decidedAt but preserving the outcome note', async () => {
    const { cookie } = await registerWithSpace('reopen-basic');
    const created = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'x' });
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${created.body.id}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionRes.body.id, outcomeNote: 'Tried Austin' });

    const res = await request(app.getHttpServer()).patch(`/decisions/${created.body.id}/reopen`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.chosenOptionId).toBeNull();
    expect(res.body.decidedAt).toBeNull();
    expect(res.body.outcomeNote).toBe('Tried Austin');
  });

  it('rejects reopening a decision that is already open with 400', async () => {
    const { cookie } = await registerWithSpace('reopen-already-open');
    const created = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'x' });

    const res = await request(app.getHttpServer()).patch(`/decisions/${created.body.id}/reopen`).set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('blocks deleting an option that is the chosen option of a decided decision', async () => {
    const { cookie } = await registerWithSpace('delete-chosen-blocked');
    const created = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: 'x' });
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${created.body.id}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', cookie)
      .send({ chosenOptionId: optionRes.body.id });

    const deleteRes = await request(app.getHttpServer())
      .delete(`/decisions/${created.body.id}/options/${optionRes.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(400);

    const detailRes = await request(app.getHttpServer()).get(`/decisions/${created.body.id}`).set('Cookie', cookie);
    expect(detailRes.body.chosenOptionId).toBe(optionRes.body.id);
    expect(detailRes.body.options).toHaveLength(1);
  });

  it('either partner may decide and reopen a decision the other created', async () => {
    const creator = await registerWithSpace('either-partner-lifecycle-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `decisions-either-partner-lifecycle-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(joinerEmail);
    const joinerRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: joinerEmail, password: 'supersecret' });
    const joinerRegisterCookie = joinerRegister.headers['set-cookie'] as unknown as string[];
    const joinerRedeem = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', joinerRegisterCookie)
      .send({ code: codeRes.body.code });
    const joinerCookie = joinerRedeem.headers['set-cookie'] as unknown as string[];

    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator decision' });
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${created.body.id}/options`)
      .set('Cookie', creator.cookie)
      .send({ label: 'Austin' });

    const decideByJoiner = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/decide`)
      .set('Cookie', joinerCookie)
      .send({ chosenOptionId: optionRes.body.id });
    expect(decideByJoiner.status).toBe(200);

    const reopenByJoiner = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}/reopen`)
      .set('Cookie', joinerCookie);
    expect(reopenByJoiner.status).toBe(200);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- decisions.controller.spec.ts`
Expected: FAIL — `PATCH /decisions/:id/decide` and `/reopen` return 404 (routes don't exist).

- [ ] **Step 3: Add `decide` and `reopen` to `apps/api/src/decisions/decisions.service.ts`**

Add this method inside the `DecisionsService` class (after `remove()`, before the option/trade-off methods added in Task 4 — order within the class doesn't matter functionally, but keep decision-level lifecycle methods grouped together):

```typescript
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
```

Add `DecideDecisionRequest` to the existing type-only import from `@us-os/shared-types`:

```diff
 import type {
   CreateDecisionRequest,
   CreateDecisionOptionRequest,
   CreateTradeOffItemRequest,
+  DecideDecisionRequest,
   UpdateDecisionRequest,
```

- [ ] **Step 4: Add `decide` and `reopen` routes to `apps/api/src/decisions/decisions.controller.ts`**

Add `DecideDecisionRequestSchema`/`DecideDecisionRequest` to the existing imports:

```diff
 import {
   CreateDecisionRequestSchema,
   CreateDecisionOptionRequestSchema,
   CreateTradeOffItemRequestSchema,
+  DecideDecisionRequestSchema,
   UpdateDecisionRequestSchema,
   UpdateDecisionOptionRequestSchema,
   UpdateTradeOffItemRequestSchema,
   type CreateDecisionRequest,
   type CreateDecisionOptionRequest,
   type CreateTradeOffItemRequest,
+  type DecideDecisionRequest,
   type UpdateDecisionRequest,
```

Add these methods inside the `DecisionsController` class (after `remove()`, before the option routes):

```typescript
  @Patch(':id/decide')
  async decide(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(createZodValidationPipe(DecideDecisionRequestSchema)) dto: DecideDecisionRequest,
  ) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.decide(id, dto);
  }

  @Patch(':id/reopen')
  async reopen(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.decisionsService.reopen(id);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/api test -- decisions`
Expected: PASS, all cases in both `decisions.controller.spec.ts` and `decisions-options.controller.spec.ts` green.

- [ ] **Step 6: Run the full backend suite and typecheck**

Run: `pnpm --filter @us-os/api test && pnpm --filter @us-os/api typecheck && pnpm --filter @us-os/api lint`
Expected: all green, no regressions in existing `milestones`/`auth`/`spaces` tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/decisions
git commit -m "feat: add decide/reopen lifecycle with deletion guard for chosen options"
```

---

### Task 6: Frontend — decisions list and comparison views

**Files:**
- Create: `apps/web/app/decisions/page.tsx`
- Create: `apps/web/app/decisions/[id]/page.tsx`

**Interfaces:**
- Consumes: `apiFetch<T>(path, init)` (`apps/web/lib/api.ts`); `AuthMeResponse` (existing, from `@us-os/shared-types`); `DecisionListItemResponse`, `DecisionDetailResponse`, `DecisionOptionResponse`, `TradeOffItemResponse`, `CreateDecisionRequest`, `CreateDecisionOptionRequest`, `CreateTradeOffItemRequest`, `DecideDecisionRequest`, `TradeOffType` (Task 2).

This task is manually verified in a browser (no automated frontend tests exist yet in this codebase — `apps/web/app/timeline/page.tsx` has none either, matching precedent), plus a build/typecheck check.

- [ ] **Step 1: Write `apps/web/app/decisions/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AuthMeResponse, DecisionListItemResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function DecisionsPage() {
  const router = useRouter();
  const [decisions, setDecisions] = useState<DecisionListItemResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<DecisionListItemResponse[]>('/decisions'))
      .then(setDecisions)
      .catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<DecisionListItemResponse>('/decisions', {
        method: 'POST',
        body: JSON.stringify({ title, rationale: rationale || null }),
      });
      setDecisions((prev) => [created, ...(prev ?? [])]);
      setTitle('');
      setRationale('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (decisions === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Decisions</h1>

      <ul>
        {decisions.map((decision) => (
          <li key={decision.id}>
            <Link href={`/decisions/${decision.id}`}>{decision.title}</Link> — {decision.status}
            {decision.rationale && <p>{decision.rationale}</p>}
          </li>
        ))}
      </ul>

      <h2>New decision</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Rationale <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create decision</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: Write `apps/web/app/decisions/[id]/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type {
  AuthMeResponse,
  DecisionDetailResponse,
  DecisionOptionResponse,
  TradeOffType,
} from '@us-os/shared-types';
import { apiFetch } from '../../../lib/api';

function computeScore(tradeOffs: DecisionOptionResponse['tradeOffs']): number {
  return tradeOffs.reduce((sum, item) => sum + (item.type === 'pro' ? item.weight : -item.weight), 0);
}

export default function DecisionDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const decisionId = params.id;

  const [decision, setDecision] = useState<DecisionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [optionLabel, setOptionLabel] = useState('');
  const [tradeOffForms, setTradeOffForms] = useState<
    Record<string, { type: TradeOffType; label: string; weight: number }>
  >({});
  const [chosenOptionId, setChosenOptionId] = useState('');
  const [outcomeNote, setOutcomeNote] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<DecisionDetailResponse>(`/decisions/${decisionId}`))
      .then(setDecision)
      .catch(() => router.push('/login'));
  }, [decisionId, router]);

  function tradeOffFormFor(optionId: string) {
    return tradeOffForms[optionId] ?? { type: 'pro' as TradeOffType, label: '', weight: 3 };
  }

  async function refresh() {
    const updated = await apiFetch<DecisionDetailResponse>(`/decisions/${decisionId}`);
    setDecision(updated);
  }

  async function handleAddOption(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/options`, {
        method: 'POST',
        body: JSON.stringify({ label: optionLabel }),
      });
      setOptionLabel('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeleteOption(optionId: string) {
    if (!window.confirm('Delete this option?')) return;
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/options/${optionId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAddTradeOff(optionId: string, e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const form = tradeOffFormFor(optionId);
    try {
      await apiFetch(`/decisions/${decisionId}/options/${optionId}/tradeoffs`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setTradeOffForms((prev) => ({ ...prev, [optionId]: { type: 'pro', label: '', weight: 3 } }));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeleteTradeOff(optionId: string, tradeoffId: string) {
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/options/${optionId}/tradeoffs/${tradeoffId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDecide(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/decide`, {
        method: 'PATCH',
        body: JSON.stringify({ chosenOptionId, outcomeNote: outcomeNote || undefined }),
      });
      setChosenOptionId('');
      setOutcomeNote('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleReopen() {
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/reopen`, { method: 'PATCH' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (decision === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  const chosenOption = decision.options.find((option) => option.id === decision.chosenOptionId);

  return (
    <main>
      <h1>{decision.title}</h1>
      <p>Status: {decision.status}</p>
      {decision.rationale && <p>{decision.rationale}</p>}

      {decision.options.map((option) => {
        const form = tradeOffFormFor(option.id);
        return (
          <section key={option.id}>
            <h2>
              {option.label} — score: {computeScore(option.tradeOffs)}
            </h2>
            <ul>
              {option.tradeOffs.map((item) => (
                <li key={item.id}>
                  [{item.type}] {item.label} (weight {item.weight}){' '}
                  <button type="button" onClick={() => handleDeleteTradeOff(option.id, item.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={(e) => handleAddTradeOff(option.id, e)}>
              <select
                value={form.type}
                onChange={(e) =>
                  setTradeOffForms((prev) => ({
                    ...prev,
                    [option.id]: { ...form, type: e.target.value as TradeOffType },
                  }))
                }
              >
                <option value="pro">pro</option>
                <option value="con">con</option>
              </select>
              <input
                placeholder="Label"
                value={form.label}
                onChange={(e) => setTradeOffForms((prev) => ({ ...prev, [option.id]: { ...form, label: e.target.value } }))}
                required
              />
              <input
                type="number"
                min={1}
                max={5}
                value={form.weight}
                onChange={(e) =>
                  setTradeOffForms((prev) => ({ ...prev, [option.id]: { ...form, weight: Number(e.target.value) } }))
                }
              />
              <button type="submit">Add trade-off</button>
            </form>
            <button type="button" onClick={() => handleDeleteOption(option.id)}>
              Delete option
            </button>
          </section>
        );
      })}

      {decision.options.length < 6 && (
        <form onSubmit={handleAddOption}>
          <label>
            New option <input value={optionLabel} onChange={(e) => setOptionLabel(e.target.value)} required />
          </label>
          <button type="submit">Add option</button>
        </form>
      )}

      {decision.status === 'open' ? (
        <form onSubmit={handleDecide}>
          <h2>Decide</h2>
          <select value={chosenOptionId} onChange={(e) => setChosenOptionId(e.target.value)} required>
            <option value="">Choose an option</option>
            {decision.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <textarea
            placeholder="Outcome note (optional)"
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value)}
          />
          <button type="submit">Decide</button>
        </form>
      ) : (
        <section>
          <h2>Decided: {chosenOption?.label}</h2>
          {decision.outcomeNote && <p>{decision.outcomeNote}</p>}
          <button type="button" onClick={handleReopen}>
            Reopen
          </button>
        </section>
      )}

      {error && <p>{error}</p>}
    </main>
  );
}
```

- [ ] **Step 3: Manually verify in a browser**

Run: `pnpm dev --filter=web --filter=api` (or `pnpm dev` for the whole stack), then in a browser:
1. Log in (or register), go to `/decisions`, create a decision with a title and rationale.
2. Click into its detail page, add two options.
3. Add a `pro` (weight 5) and a `con` (weight 3) trade-off to the first option — confirm the score shown updates to `2` without a page reload lag.
4. Click "Decide", pick the first option, add an outcome note, submit — confirm the page shows "Decided: <label>" and the outcome note.
5. Click "Reopen" — confirm it returns to the option/decide view and the outcome note would still be present if you decide again (verify via a second decide without a note — check `/decisions/:id` response in devtools network tab shows the note preserved).

- [ ] **Step 4: Typecheck and lint the web app**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/decisions
git commit -m "feat: add minimal decisions list and comparison-view frontend"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite across the monorepo**

Run: `pnpm test`
Expected: all packages/apps green, including the new `packages/database/prisma/rls-decisions.integration.test.ts`, `packages/shared-types/src/decision.test.ts`, `apps/api/src/decisions/decisions.controller.spec.ts`, and `apps/api/src/decisions/decisions-options.controller.spec.ts`.

- [ ] **Step 2: Run typecheck and lint across the monorepo**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Confirm every spec test case from the design doc has a corresponding automated test**

Cross-check against the 18 numbered test cases in `docs/superpowers/specs/2026-07-30-fr05-decision-framing-matrix-design.md`'s Testing strategy section:
1-3 → Task 3's rationale/list tests. 4-5 → Task 4's tradeoff-CRUD/score test. 6 → Task 4's cap tests. 7-11 → Task 5's lifecycle tests. 12 → Task 5's deletion-guard test. 13 → covered implicitly by cascade FK (`ON DELETE CASCADE`) — add one explicit assertion if missing: after Task 3's `deletes a decision` test, confirm via a direct `prisma.decisionOption.findMany` that child rows are gone. 14 → Task 1's RLS test. 15 → Task 3/4's validation tests. 16 → Task 3's 401 test. 17 → Task 3/5's either-partner tests. 18 → Task 3's list-shape test.

If Step 3 finds test 13's cascade isn't explicitly asserted, add it now to `decisions.controller.spec.ts`'s `deletes a decision` test:

```typescript
    // (append inside the existing 'deletes a decision' test, after the listRes assertion)
    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const remainingOptions = await TenantContext.run(spaceId, () =>
      prisma.decisionOption.findMany({ where: { decisionId: created.body.id } }),
    );
    expect(remainingOptions).toEqual([]);
```

(This requires adding `TenantContext` and `prisma` imports if not already present in that spec file — they already are, from Step 1 of Task 3.) To exercise this meaningfully, first create an option on the decision before deleting it in that test.

- [ ] **Step 4: Commit if Step 3 required a change**

```bash
git add apps/api/src/decisions/decisions.controller.spec.ts
git commit -m "test: assert cascade delete of options when a decision is deleted"
```

(Skip this commit if Step 3 found no gap.)

---

## Self-Review Notes

- **Spec coverage:** every data-model field, encryption rule, route, validation rule, lifecycle guard, and non-goal in the design spec maps to a task above; Task 7 explicitly cross-checks all 18 test cases.
- **No placeholders:** every step has literal, complete code — no "add validation" or "similar to Task N" shortcuts.
- **Type consistency:** `DecisionOptionResponse`, `TradeOffItemResponse`, `DecisionListItemResponse`, `DecisionDetailResponse` (Task 2) are used with identical field names throughout `decisions.service.ts` (Tasks 3-5) and the frontend (Task 6); `MAX_OPTIONS_PER_DECISION`/`MAX_TRADEOFFS_PER_OPTION` are defined once (Task 4) and referenced only there since the frontend cap check (`options.length < 6`) is a UX nicety, not the enforcement point — the service is.
