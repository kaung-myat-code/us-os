# FR-03 & FR-04: Goals & Mutual Promises Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partners track long-term `Goal`s (title, category, target date, manual 0-100 progress, active/achieved/abandoned status) and one-time `Promise`s (title, due date, pending/kept/broken status, resolved by either partner) — two independent backend modules plus minimal unstyled frontend pages.

**Architecture:** Two new, unrelated Prisma models (`Goal`, `Promise`), each flat (no child tables) with its own `spaceId` for RLS, following FR-02's `Milestone` pattern exactly. Two new NestJS modules, `apps/api/src/goals` and `apps/api/src/promises`, each reusing FR-02/FR-05's `CryptoService` for one encrypted free-text field (`description` on Goal, `note` on Promise). Minimal unstyled Next.js pages at `/goals` and `/promises`.

**Tech Stack:** NestJS, Prisma, PostgreSQL 16 (RLS), Zod (`packages/shared-types`), Next.js App Router, Jest (`apps/api`, integration tests against real Postgres via docker-compose), Vitest (`packages/shared-types`).

## Global Constraints

- New tables (`goals`, `promises`) carry `space_id` and get the identical `tenant_isolation` RLS policy already used on `milestones`/`decisions`.
- Goal's `description` and Promise's `note` are AES-256-GCM encrypted via the existing `CryptoService`; nothing else is encrypted. Ciphertext columns are never serialized in API responses.
- Goal `progress` (0-100) and `status` (`active`|`achieved`|`abandoned`) are fully independent — no auto-sync, no cross-field validation. `achievedAt` is set when `status` transitions to `achieved`, left alone on further edits while still `achieved`, cleared when `status` moves away from `achieved`.
- Promise `status` (`pending`|`kept`|`broken`) changes only via a dedicated `resolve` action, which sets `resolvedAt`/`resolvedBy` to the calling user. Either partner may resolve, including the promisor. Re-resolving (including to the same status again) is allowed and overwrites `status`/`resolvedAt`/`resolvedBy`.
- No future-only date validation on `targetDate`/`dueDate` — backdating is allowed, matching FR-02's unrestricted `eventDate`.
- No optimistic locking (no `version` field) — last-write-wins throughout, same as FR-02/FR-05.
- No Goal↔Promise relationship of any kind.
- Authorization: no per-entry ownership check; either partner may edit/delete/resolve anything in the shared space. A row invisible under RLS (wrong space or missing) always maps to `404`, never `403`.
- All error responses use the existing RFC 7807 `HttpExceptionFilter` — controllers/services just throw plain Nest exceptions (`NotFoundException`, `BadRequestException`), never format bodies themselves.
- Reference spec: `docs/superpowers/specs/2026-07-31-fr03-fr04-goals-mutual-promises-design.md`.

---

## File Structure

**Create:**
- `packages/database/prisma/migrations/<timestamp>_add_goal_and_promise_tables/migration.sql` — new tables + RLS
- `packages/shared-types/src/goal.ts` — Goal Zod schemas + response types
- `packages/shared-types/src/goal.test.ts`
- `packages/shared-types/src/promise.ts` — Promise Zod schemas + response types
- `packages/shared-types/src/promise.test.ts`
- `apps/api/src/goals/goals.module.ts`
- `apps/api/src/goals/goals.service.ts`
- `apps/api/src/goals/goals.controller.ts`
- `apps/api/src/goals/goals.controller.spec.ts`
- `apps/api/src/promises/promises.module.ts`
- `apps/api/src/promises/promises.service.ts`
- `apps/api/src/promises/promises.controller.ts`
- `apps/api/src/promises/promises.controller.spec.ts`
- `apps/web/app/goals/page.tsx`
- `apps/web/app/promises/page.tsx`

**Modify:**
- `packages/database/prisma/schema.prisma` — add `Goal`, `Promise` models + back-relations on `Space`/`User`
- `packages/database/src/client.ts` — add both new models to `TENANT_SCOPED_MODELS`
- `packages/database/src/index.ts` — export the two new Prisma types
- `packages/shared-types/src/index.ts` — export `./goal` and `./promise`
- `apps/api/src/app.module.ts` — register `GoalsModule` and `PromisesModule`

---

### Task 1: Database schema, migration, RLS, tenant-scoping

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/database/src/client.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/prisma/migrations/<timestamp>_add_goal_and_promise_tables/migration.sql`
- Create: `packages/database/prisma/rls-goals-promises.integration.test.ts`

**Interfaces:**
- Produces: Prisma models `Goal`, `Promise` (camelCase client accessors `prisma.goal`, `prisma.promise`), both tenant-scoped (queries require `TenantContext` to be set, same as `Milestone`/`Decision`).

- [ ] **Step 1: Add the two models to `packages/database/prisma/schema.prisma`**

Insert after the closing `}` of the `TradeOffItem` model (currently the last model, ending at line 151):

```prisma

model Goal {
  id                     String    @id @default(uuid()) @db.Uuid
  spaceId                String    @map("space_id") @db.Uuid
  createdBy              String    @map("created_by") @db.Uuid
  title                  String
  category               String    @default("other")
  targetDate             DateTime? @map("target_date") @db.Date
  progress               Int       @default(0)
  status                 String    @default("active")
  achievedAt             DateTime? @map("achieved_at")
  descriptionCiphertext  String?   @map("description_ciphertext")
  descriptionIv          String?   @map("description_iv")
  descriptionAuthTag     String?   @map("description_auth_tag")
  descriptionVersion     Int?      @map("description_version") @default(1)
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")

  space   Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  creator User  @relation(fields: [createdBy], references: [id])

  @@index([spaceId])
  @@map("goals")
}

model Promise {
  id             String    @id @default(uuid()) @db.Uuid
  spaceId        String    @map("space_id") @db.Uuid
  promisedBy     String    @map("promised_by") @db.Uuid
  title          String
  dueDate        DateTime? @map("due_date") @db.Date
  status         String    @default("pending")
  resolvedAt     DateTime? @map("resolved_at")
  resolvedBy     String?   @map("resolved_by") @db.Uuid
  noteCiphertext String?   @map("note_ciphertext")
  noteIv         String?   @map("note_iv")
  noteAuthTag    String?   @map("note_auth_tag")
  noteVersion    Int?      @map("note_version") @default(1)
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  space    Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  promisor User  @relation("PromisedBy", fields: [promisedBy], references: [id])
  resolver User? @relation("ResolvedBy", fields: [resolvedBy], references: [id])

  @@index([spaceId])
  @@map("promises")
}
```

Also add back-relations. In `model Space`, after the `tradeOffItems   TradeOffItem[]` line, add:

```prisma
  goals    Goal[]
  promises Promise[]
```

In `model User`, after the `createdDecisions Decision[]` line, add:

```prisma
  createdGoals      Goal[]
  promisedPromises  Promise[] @relation("PromisedBy")
  resolvedPromises  Promise[] @relation("ResolvedBy")
```

- [ ] **Step 2: Generate the migration (schema-only, don't apply yet)**

Run: `pnpm --filter @us-os/database exec prisma migrate dev --name add_goal_and_promise_tables --create-only --skip-generate`

This writes `packages/database/prisma/migrations/<timestamp>_add_goal_and_promise_tables/migration.sql` from the schema diff, without applying it — so the RLS statements can be hand-appended before it runs.

- [ ] **Step 3: Verify/replace the generated migration content**

Open the generated file and ensure it matches this exactly (reconcile Prisma's ordering to this if it differs, since the RLS block appended at the end depends on both tables and their FKs existing first):

```sql
-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "target_date" DATE,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "achieved_at" TIMESTAMP(3),
    "description_ciphertext" TEXT,
    "description_iv" TEXT,
    "description_auth_tag" TEXT,
    "description_version" INTEGER DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promises" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "promised_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "due_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,
    "note_ciphertext" TEXT,
    "note_iv" TEXT,
    "note_auth_tag" TEXT,
    "note_version" INTEGER DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promises_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goals_space_id_idx" ON "goals"("space_id");

-- CreateIndex
CREATE INDEX "promises_space_id_idx" ON "promises"("space_id");

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promises" ADD CONSTRAINT "promises_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promises" ADD CONSTRAINT "promises_promised_by_fkey" FOREIGN KEY ("promised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promises" ADD CONSTRAINT "promises_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: tenant isolation on goals, promises
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "goals"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

ALTER TABLE "promises" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promises" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "promises"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);
```

Note: no explicit `GRANT` is needed for `us_os_app` — the `add_restricted_app_role` migration's `ALTER DEFAULT PRIVILEGES` already covers new tables.

- [ ] **Step 4: Apply the migration and regenerate the Prisma client**

Run: `pnpm db:migrate` (applies pending migrations, prompts for confirmation if run interactively — accept), then `pnpm db:generate`.

- [ ] **Step 5: Wire the new models into tenant-scoping (`packages/database/src/client.ts`)**

Change the `TENANT_SCOPED_MODELS` line:

```diff
-const TENANT_SCOPED_MODELS = new Set(['Milestone', 'Decision', 'DecisionOption', 'TradeOffItem']);
+const TENANT_SCOPED_MODELS = new Set(['Milestone', 'Decision', 'DecisionOption', 'TradeOffItem', 'Goal', 'Promise']);
```

Change the camelModel type cast to include the new camelCase model names:

```diff
       const camelModel = (model.charAt(0).toLowerCase() + model.slice(1)) as
         | 'milestone'
         | 'decision'
         | 'decisionOption'
-        | 'tradeOffItem';
+        | 'tradeOffItem'
+        | 'goal'
+        | 'promise';
```

- [ ] **Step 6: Export the new Prisma types (`packages/database/src/index.ts`)**

```diff
-export type { Space, User, SpaceMembership, PairingCode, Milestone, Decision, DecisionOption, TradeOffItem } from '@prisma/client';
+export type { Space, User, SpaceMembership, PairingCode, Milestone, Decision, DecisionOption, TradeOffItem, Goal, Promise } from '@prisma/client';
```

- [ ] **Step 7: Write the RLS isolation test (`packages/database/prisma/rls-goals-promises.integration.test.ts`)**

```typescript
import { prisma } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation on goals and promises (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };
  let userA: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Goals Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Goals Space B' } });
    userA = await prisma.user.create({
      data: { email: `rls-goals-a-${Date.now()}@example.com`, passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.$disconnect();
  });

  it('isolates goals between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.goal.create({ data: { spaceId: spaceA.id, createdBy: userA.id, title: 'A goal' } }),
    );

    const goalsFromB = await TenantContext.run(spaceB.id, () => prisma.goal.findMany());
    expect(goalsFromB).toEqual([]);

    const goalsFromA = await TenantContext.run(spaceA.id, () => prisma.goal.findMany());
    expect(goalsFromA.map((g) => g.title)).toEqual(['A goal']);
  });

  it('isolates promises between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.promise.create({ data: { spaceId: spaceA.id, promisedBy: userA.id, title: 'A promise' } }),
    );

    const promisesFromB = await TenantContext.run(spaceB.id, () => prisma.promise.findMany());
    expect(promisesFromB).toEqual([]);

    const promisesFromA = await TenantContext.run(spaceA.id, () => prisma.promise.findMany());
    expect(promisesFromA.map((p) => p.title)).toEqual(['A promise']);
  });
});
```

- [ ] **Step 8: Run the new test to verify it passes**

Run: `pnpm --filter @us-os/database test` (or `jest packages/database/prisma/rls-goals-promises.integration.test.ts` from repo root if no package-level script exists, matching how `rls.integration.test.ts`/`rls-decisions.integration.test.ts` are already run).

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/database
git commit -m "feat: add Goal and Promise schema with RLS"
```

---

### Task 2: Shared-types Zod schemas and response types — Goal

**Files:**
- Create: `packages/shared-types/src/goal.ts`
- Create: `packages/shared-types/src/goal.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `GoalCategorySchema`/`GoalCategory`, `GoalStatusSchema`/`GoalStatus`, `CreateGoalRequestSchema`/`CreateGoalRequest`, `UpdateGoalRequestSchema`/`UpdateGoalRequest`, `GoalResponse` — consumed by Task 4's controller/service.

- [ ] **Step 1: Write the schema validation tests (`packages/shared-types/src/goal.test.ts`)**

```typescript
import { describe, expect, it } from 'vitest';
import { CreateGoalRequestSchema, UpdateGoalRequestSchema, GoalCategorySchema, GoalStatusSchema } from './goal';

describe('GoalCategorySchema', () => {
  it('accepts each known category', () => {
    for (const category of ['financial', 'health', 'travel', 'career', 'relationship', 'other']) {
      expect(GoalCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(GoalCategorySchema.safeParse('hobby').success).toBe(false);
  });
});

describe('GoalStatusSchema', () => {
  it('accepts active, achieved, abandoned', () => {
    for (const status of ['active', 'achieved', 'abandoned']) {
      expect(GoalStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(GoalStatusSchema.safeParse('paused').success).toBe(false);
  });
});

describe('CreateGoalRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'Save for a house' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 characters', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects an invalid category', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', category: 'hobby' }).success).toBe(false);
  });

  it('rejects a description over 10000 characters', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', description: 'a'.repeat(10001) }).success).toBe(false);
  });

  it('accepts an explicit null description', () => {
    expect(CreateGoalRequestSchema.safeParse({ title: 'x', description: null }).success).toBe(true);
  });
});

describe('UpdateGoalRequestSchema', () => {
  it('accepts an empty object', () => {
    expect(UpdateGoalRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts progress and status independently, in any combination', () => {
    expect(UpdateGoalRequestSchema.safeParse({ progress: 100, status: 'active' }).success).toBe(true);
    expect(UpdateGoalRequestSchema.safeParse({ progress: 70, status: 'achieved' }).success).toBe(true);
  });

  it('rejects progress outside 0-100', () => {
    expect(UpdateGoalRequestSchema.safeParse({ progress: -1 }).success).toBe(false);
    expect(UpdateGoalRequestSchema.safeParse({ progress: 101 }).success).toBe(false);
  });

  it('rejects a non-integer progress', () => {
    expect(UpdateGoalRequestSchema.safeParse({ progress: 50.5 }).success).toBe(false);
  });

  it('distinguishes an absent description key from an explicit null', () => {
    const omitted = UpdateGoalRequestSchema.parse({ title: 'x' });
    const explicit = UpdateGoalRequestSchema.parse({ title: 'x', description: null });
    expect('description' in omitted).toBe(false);
    expect('description' in explicit).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (module doesn't exist yet)**

Run: `pnpm --filter @us-os/shared-types test`
Expected: FAIL with a module-resolution error for `./goal`.

- [ ] **Step 3: Write `packages/shared-types/src/goal.ts`**

```typescript
import { z } from 'zod';

export const GoalCategorySchema = z.enum(['financial', 'health', 'travel', 'career', 'relationship', 'other']);
export type GoalCategory = z.infer<typeof GoalCategorySchema>;

export const GoalStatusSchema = z.enum(['active', 'achieved', 'abandoned']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const CreateGoalRequestSchema = z.object({
  title: z.string().min(1).max(200),
  category: GoalCategorySchema.optional(),
  targetDate: z.string().nullable().optional(),
  description: z.string().max(10000).nullable().optional(),
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequestSchema>;

export const UpdateGoalRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: GoalCategorySchema.optional(),
  targetDate: z.string().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  status: GoalStatusSchema.optional(),
  description: z.string().max(10000).nullable().optional(),
});
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequestSchema>;

export interface GoalResponse {
  id: string;
  title: string;
  category: GoalCategory;
  targetDate: string | null;
  progress: number;
  status: GoalStatus;
  achievedAt: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Export it from the package index**

```diff
 export * from './health';
 export * from './auth';
 export * from './space';
 export * from './milestone';
 export * from './decision';
+export * from './goal';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/shared-types test`
Expected: PASS, all cases green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-types
git commit -m "feat: add Goal Zod schemas and response types to shared-types"
```

---

### Task 3: Shared-types Zod schemas and response types — Promise

**Files:**
- Create: `packages/shared-types/src/promise.ts`
- Create: `packages/shared-types/src/promise.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `PromiseStatusSchema`/`PromiseStatus`, `CreatePromiseRequestSchema`/`CreatePromiseRequest`, `UpdatePromiseRequestSchema`/`UpdatePromiseRequest`, `ResolvePromiseRequestSchema`/`ResolvePromiseRequest`, `PromiseResponse` — consumed by Task 5's controller/service.

- [ ] **Step 1: Write the schema validation tests (`packages/shared-types/src/promise.test.ts`)**

```typescript
import { describe, expect, it } from 'vitest';
import { CreatePromiseRequestSchema, UpdatePromiseRequestSchema, ResolvePromiseRequestSchema, PromiseStatusSchema } from './promise';

describe('PromiseStatusSchema', () => {
  it('accepts pending, kept, broken', () => {
    for (const status of ['pending', 'kept', 'broken']) {
      expect(PromiseStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(PromiseStatusSchema.safeParse('cancelled').success).toBe(false);
  });
});

describe('CreatePromiseRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'Book the flights' }).success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 characters', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects a note over 10000 characters', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'x', note: 'a'.repeat(10001) }).success).toBe(false);
  });

  it('accepts an explicit null note', () => {
    expect(CreatePromiseRequestSchema.safeParse({ title: 'x', note: null }).success).toBe(true);
  });
});

describe('UpdatePromiseRequestSchema', () => {
  it('accepts an empty object', () => {
    expect(UpdatePromiseRequestSchema.safeParse({}).success).toBe(true);
  });

  it('distinguishes an absent note key from an explicit null', () => {
    const omitted = UpdatePromiseRequestSchema.parse({ title: 'x' });
    const explicit = UpdatePromiseRequestSchema.parse({ title: 'x', note: null });
    expect('note' in omitted).toBe(false);
    expect('note' in explicit).toBe(true);
  });
});

describe('ResolvePromiseRequestSchema', () => {
  it('accepts kept and broken', () => {
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'kept' }).success).toBe(true);
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'broken' }).success).toBe(true);
  });

  it('rejects pending as a resolve target', () => {
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('rejects a missing status', () => {
    expect(ResolvePromiseRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an optional note', () => {
    expect(ResolvePromiseRequestSchema.safeParse({ status: 'kept', note: 'Booked it' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (module doesn't exist yet)**

Run: `pnpm --filter @us-os/shared-types test`
Expected: FAIL with a module-resolution error for `./promise`.

- [ ] **Step 3: Write `packages/shared-types/src/promise.ts`**

```typescript
import { z } from 'zod';

export const PromiseStatusSchema = z.enum(['pending', 'kept', 'broken']);
export type PromiseStatus = z.infer<typeof PromiseStatusSchema>;

export const CreatePromiseRequestSchema = z.object({
  title: z.string().min(1).max(200),
  dueDate: z.string().nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
});
export type CreatePromiseRequest = z.infer<typeof CreatePromiseRequestSchema>;

export const UpdatePromiseRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  dueDate: z.string().nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
});
export type UpdatePromiseRequest = z.infer<typeof UpdatePromiseRequestSchema>;

export const ResolvePromiseRequestSchema = z.object({
  status: z.enum(['kept', 'broken']),
  note: z.string().max(10000).nullable().optional(),
});
export type ResolvePromiseRequest = z.infer<typeof ResolvePromiseRequestSchema>;

export interface PromiseResponse {
  id: string;
  title: string;
  promisedBy: string;
  dueDate: string | null;
  status: PromiseStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Export it from the package index**

```diff
 export * from './health';
 export * from './auth';
 export * from './space';
 export * from './milestone';
 export * from './decision';
 export * from './goal';
+export * from './promise';
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
git commit -m "feat: add Promise Zod schemas and response types to shared-types"
```

---

### Task 4: Goals module (service + controller + module)

**Files:**
- Create: `apps/api/src/goals/goals.module.ts`
- Create: `apps/api/src/goals/goals.service.ts`
- Create: `apps/api/src/goals/goals.controller.ts`
- Create: `apps/api/src/goals/goals.controller.spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `CryptoService.encryptNote(plaintext): EncryptedNote` / `.decryptNote(EncryptedNote): string` (`apps/api/src/crypto/crypto.service.ts`); `createZodValidationPipe(schema)` (`apps/api/src/common/zod-validation.pipe.ts`); `requireSpaceId(spaceId): string` (`apps/api/src/milestones/require-space.ts`); `AuthenticatedUser` (`apps/api/src/auth/types.ts`); `CreateGoalRequestSchema`/`UpdateGoalRequestSchema`/types/`GoalResponse` from Task 2.
- Produces: `GoalsService` with `list()`, `create()`, `get()`, `update()`, `remove()` — consumed by `GoalsController` in this task.

- [ ] **Step 1: Write the failing integration tests (`apps/api/src/goals/goals.controller.spec.ts`)**

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
import { GoalsModule } from './goals.module';

describe('GoalsController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, GoalsModule],
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
    const email = `goals-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  it('creates a goal with defaults when only a title is given', async () => {
    const { cookie } = await registerWithSpace('create-defaults');

    const res = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'Run a marathon' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Run a marathon');
    expect(res.body.category).toBe('other');
    expect(res.body.progress).toBe(0);
    expect(res.body.status).toBe('active');
    expect(res.body.achievedAt).toBeNull();
    expect(res.body.description).toBeNull();
  });

  it('round-trips a description and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('description-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', cookie)
      .send({ title: 'Save for a house', category: 'financial', description: 'Aiming to avoid PMI' });

    expect(created.body.description).toBe('Aiming to avoid PMI');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () => prisma.goal.findFirstOrThrow({ where: { id: created.body.id } }));
    expect(rawRow.descriptionCiphertext).not.toBeNull();
    expect(rawRow.descriptionCiphertext).not.toContain('Aiming to avoid PMI');
  });

  it('excludes another space’s goals from the list (RLS)', async () => {
    const { cookie: cookieA } = await registerWithSpace('rls-list-a');
    const { cookie: cookieB } = await registerWithSpace('rls-list-b');

    await request(app.getHttpServer()).post('/goals').set('Cookie', cookieA).send({ title: 'Space A goal' });

    const res = await request(app.getHttpServer()).get('/goals').set('Cookie', cookieB);
    expect(res.body.map((g: { title: string }) => g.title)).not.toContain('Space A goal');
  });

  it('updates progress and status independently, in any combination', async () => {
    const { cookie } = await registerWithSpace('progress-status');
    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'Half marathon' });

    const res1 = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ progress: 100, status: 'active' });
    expect(res1.status).toBe(200);
    expect(res1.body.progress).toBe(100);
    expect(res1.body.status).toBe('active');

    const res2 = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ progress: 55, status: 'achieved' });
    expect(res2.status).toBe(200);
    expect(res2.body.progress).toBe(55);
    expect(res2.body.status).toBe('achieved');
  });

  it('sets achievedAt on transition to achieved, and clears it on transition away', async () => {
    const { cookie } = await registerWithSpace('achieved-at');
    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'Learn Spanish' });

    const achieved = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'achieved' });
    expect(achieved.body.achievedAt).not.toBeNull();

    const stillAchieved = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Learn Spanish fluently' });
    expect(stillAchieved.body.achievedAt).toBe(achieved.body.achievedAt);

    const reactivated = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    expect(reactivated.body.achievedAt).toBeNull();
  });

  it('deletes a goal', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'To delete' });

    const deleteRes = await request(app.getHttpServer()).delete(`/goals/${created.body.id}`).set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/goals').set('Cookie', cookie);
    expect(listRes.body.map((g: { id: string }) => g.id)).not.toContain(created.body.id);
  });

  it('either partner in the space may edit and delete a goal the other created', async () => {
    const creator = await registerWithSpace('either-partner-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `goals-either-partner-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
      .post('/goals')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator goal' });

    const editByJoiner = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', joinerCookie)
      .send({ title: 'Edited by joiner' });
    expect(editByJoiner.status).toBe(200);

    const deleteByJoiner = await request(app.getHttpServer()).delete(`/goals/${created.body.id}`).set('Cookie', joinerCookie);
    expect(deleteByJoiner.status).toBe(204);
  });

  it('returns 404 (not 403) when getting, updating, or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', cookieA)
      .send({ title: 'Space A goal' });

    const getRes = await request(app.getHttpServer()).get(`/goals/${created.body.id}`).set('Cookie', cookieB);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer()).delete(`/goals/${created.body.id}`).set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create and update', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: '' });
    expect(emptyTitle.status).toBe(400);

    const badCategory = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', cookie)
      .send({ title: 'x', category: 'hobby' });
    expect(badCategory.status).toBe(400);

    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'x' });

    const badProgress = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ progress: 150 });
    expect(badProgress.status).toBe(400);

    const badStatus = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'paused' });
    expect(badStatus.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all goal endpoints', async () => {
    const getRes = await request(app.getHttpServer()).get('/goals');
    const postRes = await request(app.getHttpServer()).post('/goals').send({ title: 'x' });
    const patchRes = await request(app.getHttpServer()).patch('/goals/00000000-0000-0000-0000-000000000000').send({});
    const deleteRes = await request(app.getHttpServer()).delete('/goals/00000000-0000-0000-0000-000000000000');

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- goals.controller.spec.ts`
Expected: FAIL — `Cannot find module './goals.module'`.

- [ ] **Step 3: Write `apps/api/src/goals/goals.service.ts`**

```typescript
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
```

- [ ] **Step 4: Write `apps/api/src/goals/goals.controller.ts`**

```typescript
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
```

- [ ] **Step 5: Write `apps/api/src/goals/goals.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [GoalsController],
  providers: [GoalsService],
})
export class GoalsModule {}
```

- [ ] **Step 6: Register the module in `apps/api/src/app.module.ts`**

```diff
 import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
 import cookieParser from 'cookie-parser';
 import { AuthModule } from './auth/auth.module';
 import { DecisionsModule } from './decisions/decisions.module';
+import { GoalsModule } from './goals/goals.module';
 import { HealthController } from './health/health.controller';
 import { MilestonesModule } from './milestones/milestones.module';
 import { SessionModule } from './session/session.module';
 import { SpacesModule } from './spaces/spaces.module';
 import { TenantMiddleware } from './tenant/tenant.middleware';

 @Module({
-  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule, DecisionsModule],
+  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule, DecisionsModule, GoalsModule],
   controllers: [HealthController],
   providers: [],
 })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/api test -- goals.controller.spec.ts`
Expected: PASS, all cases green. (Requires the docker-compose Postgres to be running.)

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @us-os/api typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/goals apps/api/src/app.module.ts
git commit -m "feat: add Goal CRUD service, controller, and module"
```

---

### Task 5: Promises module (service + controller + module, including resolve)

**Files:**
- Create: `apps/api/src/promises/promises.module.ts`
- Create: `apps/api/src/promises/promises.service.ts`
- Create: `apps/api/src/promises/promises.controller.ts`
- Create: `apps/api/src/promises/promises.controller.spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `CryptoService.encryptNote`/`.decryptNote`; `createZodValidationPipe(schema)`; `requireSpaceId(spaceId): string`; `AuthenticatedUser`; `CreatePromiseRequestSchema`/`UpdatePromiseRequestSchema`/`ResolvePromiseRequestSchema`/types/`PromiseResponse` from Task 3.
- Produces: `PromisesService` with `list()`, `create()`, `get()`, `update()`, `resolve()`, `remove()` — consumed by `PromisesController` in this task.

- [ ] **Step 1: Write the failing integration tests (`apps/api/src/promises/promises.controller.spec.ts`)**

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
import { PromisesModule } from './promises.module';

describe('PromisesController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, PromisesModule],
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
    const email = `promises-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  async function addPartner(
    creatorCookie: string[],
    label: string,
  ): Promise<{ cookie: string[]; email: string }> {
    const codeRes = await request(app.getHttpServer()).post('/spaces/pairing-codes').set('Cookie', creatorCookie).send({});
    const email = `promises-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const registerCookie = registerRes.headers['set-cookie'] as unknown as string[];
    const redeemRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', registerCookie)
      .send({ code: codeRes.body.code });
    return { cookie: redeemRes.headers['set-cookie'] as unknown as string[], email };
  }

  it('creates a promise as pending, with promisedBy set to the caller', async () => {
    const { cookie } = await registerWithSpace('create-basic');

    const res = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'Book the flights' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Book the flights');
    expect(res.body.status).toBe('pending');
    expect(res.body.resolvedAt).toBeNull();
    expect(res.body.resolvedBy).toBeNull();
    expect(typeof res.body.promisedBy).toBe('string');
  });

  it('round-trips a note and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('note-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookie)
      .send({ title: 'Book flights', note: 'Aisle seats please' });

    expect(created.body.note).toBe('Aisle seats please');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () => prisma.promise.findFirstOrThrow({ where: { id: created.body.id } }));
    expect(rawRow.noteCiphertext).not.toBeNull();
    expect(rawRow.noteCiphertext).not.toContain('Aisle seats please');
  });

  it('excludes another space’s promises from the list (RLS)', async () => {
    const { cookie: cookieA } = await registerWithSpace('rls-list-a');
    const { cookie: cookieB } = await registerWithSpace('rls-list-b');

    await request(app.getHttpServer()).post('/promises').set('Cookie', cookieA).send({ title: 'Space A promise' });

    const res = await request(app.getHttpServer()).get('/promises').set('Cookie', cookieB);
    expect(res.body.map((p: { title: string }) => p.title)).not.toContain('Space A promise');
  });

  it('lets the other partner (not just the promisor) resolve a promise', async () => {
    const creator = await registerWithSpace('resolve-partner-creator');
    const partner = await addPartner(creator.cookie, 'resolve-partner-joiner');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', creator.cookie)
      .send({ title: 'Do the dishes' });

    const resolved = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', partner.cookie)
      .send({ status: 'kept' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('kept');
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect(resolved.body.resolvedBy).not.toBe(created.body.promisedBy);
  });

  it('lets the promisor resolve their own promise', async () => {
    const { cookie } = await registerWithSpace('resolve-self');
    const created = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'Call the bank' });

    const resolved = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', cookie)
      .send({ status: 'broken' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('broken');
  });

  it('re-resolving overwrites status, resolvedAt, and resolvedBy, including to the same status again', async () => {
    const creator = await registerWithSpace('re-resolve-creator');
    const partner = await addPartner(creator.cookie, 're-resolve-joiner');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', creator.cookie)
      .send({ title: 'Pack the car' });

    const first = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', creator.cookie)
      .send({ status: 'kept' });
    expect(first.body.status).toBe('kept');

    const overwrite = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', partner.cookie)
      .send({ status: 'broken' });
    expect(overwrite.body.status).toBe('broken');
    expect(overwrite.body.resolvedBy).not.toBe(first.body.resolvedBy);

    const sameStatusAgain = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', partner.cookie)
      .send({ status: 'broken' });
    expect(sameStatusAgain.status).toBe(200);
    expect(sameStatusAgain.body.status).toBe('broken');
  });

  it('rejects resolving to pending with 400', async () => {
    const { cookie } = await registerWithSpace('resolve-pending-rejected');
    const created = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'x' });

    const res = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', cookie)
      .send({ status: 'pending' });
    expect(res.status).toBe(400);
  });

  it('deletes a promise', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'To delete' });

    const deleteRes = await request(app.getHttpServer()).delete(`/promises/${created.body.id}`).set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/promises').set('Cookie', cookie);
    expect(listRes.body.map((p: { id: string }) => p.id)).not.toContain(created.body.id);
  });

  it('returns 404 (not 403) when getting, updating, resolving, or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookieA)
      .send({ title: 'Space A promise' });

    const getRes = await request(app.getHttpServer()).get(`/promises/${created.body.id}`).set('Cookie', cookieB);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const resolveRes = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', cookieB)
      .send({ status: 'kept' });
    expect(resolveRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer()).delete(`/promises/${created.body.id}`).set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: '' });
    expect(emptyTitle.status).toBe(400);

    const titleTooLong = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookie)
      .send({ title: 'a'.repeat(201) });
    expect(titleTooLong.status).toBe(400);

    const noteTooLong = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookie)
      .send({ title: 'x', note: 'a'.repeat(10001) });
    expect(noteTooLong.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all promise endpoints', async () => {
    const getRes = await request(app.getHttpServer()).get('/promises');
    const postRes = await request(app.getHttpServer()).post('/promises').send({ title: 'x' });
    const patchRes = await request(app.getHttpServer()).patch('/promises/00000000-0000-0000-0000-000000000000').send({});
    const resolveRes = await request(app.getHttpServer())
      .patch('/promises/00000000-0000-0000-0000-000000000000/resolve')
      .send({ status: 'kept' });
    const deleteRes = await request(app.getHttpServer()).delete('/promises/00000000-0000-0000-0000-000000000000');

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(resolveRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- promises.controller.spec.ts`
Expected: FAIL — `Cannot find module './promises.module'`.

- [ ] **Step 3: Write `apps/api/src/promises/promises.service.ts`**

```typescript
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
```

- [ ] **Step 4: Write `apps/api/src/promises/promises.controller.ts`**

```typescript
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
```

- [ ] **Step 5: Write `apps/api/src/promises/promises.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PromisesController } from './promises.controller';
import { PromisesService } from './promises.service';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [PromisesController],
  providers: [PromisesService],
})
export class PromisesModule {}
```

- [ ] **Step 6: Register the module in `apps/api/src/app.module.ts`**

```diff
 import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
 import cookieParser from 'cookie-parser';
 import { AuthModule } from './auth/auth.module';
 import { DecisionsModule } from './decisions/decisions.module';
 import { GoalsModule } from './goals/goals.module';
 import { HealthController } from './health/health.controller';
 import { MilestonesModule } from './milestones/milestones.module';
+import { PromisesModule } from './promises/promises.module';
 import { SessionModule } from './session/session.module';
 import { SpacesModule } from './spaces/spaces.module';
 import { TenantMiddleware } from './tenant/tenant.middleware';

 @Module({
-  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule, DecisionsModule, GoalsModule],
+  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule, DecisionsModule, GoalsModule, PromisesModule],
   controllers: [HealthController],
   providers: [],
 })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/api test -- promises.controller.spec.ts`
Expected: PASS, all cases green. (Requires the docker-compose Postgres to be running.)

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @us-os/api typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/promises apps/api/src/app.module.ts
git commit -m "feat: add Promise CRUD + resolve service, controller, and module"
```

---

### Task 6: Frontend — `/goals` page

**Files:**
- Create: `apps/web/app/goals/page.tsx`

**Interfaces:**
- Consumes: `apiFetch<T>(path, init?)` (`apps/web/lib/api.ts`); `AuthMeResponse`, `GoalResponse`, `GoalCategory`, `GoalStatus` (`@us-os/shared-types`, produced by Task 2 and the existing auth module).

- [ ] **Step 1: Write `apps/web/app/goals/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse, GoalCategory, GoalResponse, GoalStatus } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

const CATEGORIES: GoalCategory[] = ['financial', 'health', 'travel', 'career', 'relationship', 'other'];
const STATUSES: GoalStatus[] = ['active', 'achieved', 'abandoned'];

export default function GoalsPage() {
  const router = useRouter();
  const [goals, setGoals] = useState<GoalResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<GoalCategory>('other');
  const [targetDate, setTargetDate] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<GoalResponse[]>('/goals'))
      .then(setGoals)
      .catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<GoalResponse>('/goals', {
        method: 'POST',
        body: JSON.stringify({
          title,
          category,
          targetDate: targetDate || null,
          description: description || null,
        }),
      });
      setGoals((prev) => [created, ...(prev ?? [])]);
      setTitle('');
      setCategory('other');
      setTargetDate('');
      setDescription('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleProgressChange(goal: GoalResponse, progress: number) {
    setError(null);
    try {
      const updated = await apiFetch<GoalResponse>(`/goals/${goal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ progress }),
      });
      setGoals((prev) => (prev ?? []).map((g) => (g.id === updated.id ? updated : g)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleStatusChange(goal: GoalResponse, status: GoalStatus) {
    setError(null);
    try {
      const updated = await apiFetch<GoalResponse>(`/goals/${goal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setGoals((prev) => (prev ?? []).map((g) => (g.id === updated.id ? updated : g)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(goal: GoalResponse) {
    if (!window.confirm('Delete this goal?')) return;
    setError(null);
    try {
      await apiFetch(`/goals/${goal.id}`, { method: 'DELETE' });
      setGoals((prev) => (prev ?? []).filter((g) => g.id !== goal.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (goals === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Goals</h1>

      <ul>
        {goals.map((goal) => (
          <li key={goal.id}>
            <strong>{goal.title}</strong> — [{goal.category}] — {goal.status}
            {goal.targetDate && <span> — target: {goal.targetDate}</span>}
            {goal.description && <p>{goal.description}</p>}
            <div>
              <label>
                Progress{' '}
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={goal.progress}
                  onChange={(e) => handleProgressChange(goal, Number(e.target.value))}
                />
                %
              </label>
              <select value={goal.status} onChange={(e) => handleStatusChange(goal, e.target.value as GoalStatus)}>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              {goal.achievedAt && <span> achieved: {goal.achievedAt}</span>}
              <button type="button" onClick={() => handleDelete(goal)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>New goal</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Category{' '}
            <select value={category} onChange={(e) => setCategory(e.target.value as GoalCategory)}>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <label>
            Target date <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Description <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create goal</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: Manually verify in the browser**

Run `pnpm dev --filter=web` and `pnpm dev --filter=api` (or `pnpm dev`), navigate to `http://localhost:3000/goals` while logged in with a space, create a goal, adjust its progress input and status dropdown, and confirm both update independently without page reload issues. Delete a goal and confirm it disappears from the list.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/goals
git commit -m "feat: add /goals frontend page"
```

---

### Task 7: Frontend — `/promises` page

**Files:**
- Create: `apps/web/app/promises/page.tsx`

**Interfaces:**
- Consumes: `apiFetch<T>(path, init?)` (`apps/web/lib/api.ts`); `AuthMeResponse`, `PromiseResponse`, `PromiseStatus` (`@us-os/shared-types`, produced by Task 3 and the existing auth module).

- [ ] **Step 1: Write `apps/web/app/promises/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse, PromiseResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function PromisesPage() {
  const router = useRouter();
  const [promises, setPromises] = useState<PromiseResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<PromiseResponse[]>('/promises'))
      .then(setPromises)
      .catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<PromiseResponse>('/promises', {
        method: 'POST',
        body: JSON.stringify({ title, dueDate: dueDate || null, note: note || null }),
      });
      setPromises((prev) => [created, ...(prev ?? [])]);
      setTitle('');
      setDueDate('');
      setNote('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleResolve(promise: PromiseResponse, status: 'kept' | 'broken') {
    setError(null);
    try {
      const updated = await apiFetch<PromiseResponse>(`/promises/${promise.id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setPromises((prev) => (prev ?? []).map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(promise: PromiseResponse) {
    if (!window.confirm('Delete this promise?')) return;
    setError(null);
    try {
      await apiFetch(`/promises/${promise.id}`, { method: 'DELETE' });
      setPromises((prev) => (prev ?? []).filter((p) => p.id !== promise.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (promises === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Promises</h1>

      <ul>
        {promises.map((promise) => (
          <li key={promise.id}>
            <strong>{promise.title}</strong> — {promise.status}
            {promise.dueDate && <span> — due: {promise.dueDate}</span>}
            {promise.note && <p>{promise.note}</p>}
            {promise.status === 'pending' ? (
              <div>
                <button type="button" onClick={() => handleResolve(promise, 'kept')}>
                  Mark kept
                </button>
                <button type="button" onClick={() => handleResolve(promise, 'broken')}>
                  Mark broken
                </button>
              </div>
            ) : (
              <p>
                Resolved by {promise.resolvedBy} at {promise.resolvedAt}
              </p>
            )}
            <button type="button" onClick={() => handleDelete(promise)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <h2>New promise</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Due date <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Note <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create promise</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: Manually verify in the browser**

Run `pnpm dev --filter=web` and `pnpm dev --filter=api` (or `pnpm dev`), navigate to `http://localhost:3000/promises` while logged in with a space, create a promise, mark it kept or broken, and confirm the resolved-by/resolved-at text appears and the action buttons disappear. Delete a promise and confirm it disappears from the list.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/promises
git commit -m "feat: add /promises frontend page"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), encryption (Tasks 4/5 services), Goal lifecycle incl. `achievedAt` (Task 4), Promise lifecycle incl. resolve/re-resolve/same-status (Task 5), API surface and validation (Tasks 2-5), RLS (Task 1), frontend (Tasks 6-7) are all covered. Authorization/404-vs-403 and either-partner tests appear in Tasks 4-5. No optimistic locking, per the spec's explicit decision to drop `version`.
- **Type consistency:** `GoalResponse`/`PromiseResponse` field names match between `packages/shared-types` (Tasks 2-3) and the service `toResponse()` methods (Tasks 4-5) and frontend usage (Tasks 6-7) — `progress`, `status`, `achievedAt`, `resolvedBy`, `resolvedAt` used consistently throughout.
- **No placeholders:** all steps contain complete, runnable code; no TBD/TODO markers.
