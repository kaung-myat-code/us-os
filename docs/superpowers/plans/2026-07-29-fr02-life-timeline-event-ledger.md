# FR-02: Life Timeline & Event Ledger Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the RLS-phase placeholder `Milestone` model into the real timeline feature — encrypted notes, a category enum, attribution, full CRUD, and a minimal clickable frontend.

**Architecture:** Extend the existing `milestones` table in place (rename `occurred_at` → `event_date`, add `created_by`/`category`/four `note*` columns). A new `CryptoModule` (AES-256-GCM, direct master key) lives in `apps/api/src/crypto`, independent of the `milestones` module. A new `MilestonesModule` follows the exact shape of the existing `spaces` module (controller + service, no repository layer, RLS handles tenant scoping transparently via the existing `TenantContext`/`TenantMiddleware` machinery — no service code needs to call it directly). Shared Zod DTOs live in `packages/shared-types`. Frontend is one unstyled `/timeline` page mirroring the existing `/onboarding` page's client-component-with-`apiFetch` pattern.

**Tech Stack:** NestJS 10, Prisma 5 / PostgreSQL 16 (RLS), Zod, Node's built-in `node:crypto`, Next.js 14 App Router, Jest (`apps/api`, `packages/database`), Vitest (`packages/shared-types`).

## Global Constraints

- All new/changed queries against `Milestone` must remain covered by the existing `tenant_isolation` RLS policy — no column-level changes needed, but any new model would need the pattern repeated (not needed here; we're extending the existing table).
- `ENCRYPTION_MASTER_KEY` env var: base64, must decode to exactly 32 bytes, validated at process/module load time — app must refuse to start otherwise.
- No `class-validator` in this codebase — all request validation is Zod schemas from `@us-os/shared-types` run through `createZodValidationPipe`. Do not introduce `class-validator` for the crypto env-var check either; use a plain function that throws at module load, matching the existing `JWT_SECRET` pattern in `apps/api/src/session/session.service.ts`.
- All API error responses must stay RFC 7807 shaped — throw Nest `HttpException` subtypes (`NotFoundException`, `ConflictException`, `BadRequestException`, etc.), never raw `Error`, so `HttpExceptionFilter` can reshape them.
- `createdBy` is attribution only, not an authorization gate — either partner in the space may edit/delete any entry.
- Note ciphertext columns (`noteCiphertext`/`noteIv`/`noteAuthTag`/`noteVersion`) must never appear in an API response — only the decrypted `note` string (or `null`).
- No pagination, no soft delete, no optimistic locking, no rich text, no media — see the spec's Non-goals section. Do not add any of these.
- Test convention in this repo: `*.spec.ts` colocated next to the source file (Jest, `apps/api`), `*.test.ts` colocated next to the source file (Vitest, `packages/shared-types`), and one dedicated `packages/database/test/*.integration.test.ts` file for raw-Prisma RLS behavior. No separate `test/` or `e2e/` folder in `apps/api`.
- Spec source of truth: `docs/superpowers/specs/2026-07-29-fr02-life-timeline-event-ledger-design.md`.

---

### Task 1: Shared Zod schemas for milestone request/response DTOs

**Files:**
- Create: `packages/shared-types/src/milestone.ts`
- Create: `packages/shared-types/src/milestone.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `MilestoneCategorySchema` (`z.ZodEnum`), `MilestoneCategory` type, `CreateMilestoneRequestSchema`, `CreateMilestoneRequest` type, `UpdateMilestoneRequestSchema`, `UpdateMilestoneRequest` type, `MilestoneResponse` interface (`{ id, title, eventDate, category, note, createdBy, createdAt, updatedAt }`) — all consumed by Task 4's controller/service and Task 8's frontend page.

- [x] **Step 1: Write the failing tests**

Create `packages/shared-types/src/milestone.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CreateMilestoneRequestSchema, MilestoneCategorySchema, UpdateMilestoneRequestSchema } from './milestone';

describe('MilestoneCategorySchema', () => {
  it('accepts the four known categories', () => {
    for (const category of ['milestone', 'memory', 'decision', 'other']) {
      expect(MilestoneCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(MilestoneCategorySchema.safeParse('vacation').success).toBe(false);
  });
});

describe('CreateMilestoneRequestSchema', () => {
  it('accepts a minimal valid payload and defaults category to other', () => {
    const result = CreateMilestoneRequestSchema.safeParse({ title: 'First apartment', eventDate: '2024-03-15' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.category).toBe('other');
  });

  it('rejects an empty title', () => {
    expect(CreateMilestoneRequestSchema.safeParse({ title: '', eventDate: '2024-03-15' }).success).toBe(false);
  });

  it('rejects a full datetime string for eventDate', () => {
    expect(
      CreateMilestoneRequestSchema.safeParse({ title: 'x', eventDate: '2024-03-15T10:30:00Z' }).success,
    ).toBe(false);
  });

  it('rejects a note over 10000 characters', () => {
    const result = CreateMilestoneRequestSchema.safeParse({
      title: 'x',
      eventDate: '2024-03-15',
      note: 'a'.repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit null note', () => {
    expect(
      CreateMilestoneRequestSchema.safeParse({ title: 'x', eventDate: '2024-03-15', note: null }).success,
    ).toBe(true);
  });
});

describe('UpdateMilestoneRequestSchema', () => {
  it('accepts a partial update with only a note', () => {
    expect(UpdateMilestoneRequestSchema.safeParse({ note: 'updated' }).success).toBe(true);
  });

  it('distinguishes an absent note key from an explicit null', () => {
    const omitted = UpdateMilestoneRequestSchema.parse({ title: 'x' });
    const explicit = UpdateMilestoneRequestSchema.parse({ title: 'x', note: null });
    expect('note' in omitted).toBe(false);
    expect('note' in explicit).toBe(true);
    expect(explicit.note).toBeNull();
  });

  it('accepts an empty object (no fields changed)', () => {
    expect(UpdateMilestoneRequestSchema.safeParse({}).success).toBe(true);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/shared-types test`
Expected: FAIL — `Cannot find module './milestone'`

- [x] **Step 3: Implement the schemas**

Create `packages/shared-types/src/milestone.ts`:

```ts
import { z } from 'zod';

export const MilestoneCategorySchema = z.enum(['milestone', 'memory', 'decision', 'other']);
export type MilestoneCategory = z.infer<typeof MilestoneCategorySchema>;

const EVENT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const CreateMilestoneRequestSchema = z.object({
  title: z.string().min(1).max(500),
  eventDate: z.string().regex(EVENT_DATE_REGEX, 'eventDate must be in YYYY-MM-DD format'),
  category: MilestoneCategorySchema.default('other'),
  note: z.string().max(10000).nullable().optional(),
});
export type CreateMilestoneRequest = z.infer<typeof CreateMilestoneRequestSchema>;

export const UpdateMilestoneRequestSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  eventDate: z.string().regex(EVENT_DATE_REGEX, 'eventDate must be in YYYY-MM-DD format').optional(),
  category: MilestoneCategorySchema.optional(),
  note: z.string().max(10000).nullable().optional(),
});
export type UpdateMilestoneRequest = z.infer<typeof UpdateMilestoneRequestSchema>;

export interface MilestoneResponse {
  id: string;
  title: string;
  eventDate: string;
  category: MilestoneCategory;
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

Add to `packages/shared-types/src/index.ts` (currently 3 lines, append a 4th):

```ts
export * from './health';
export * from './auth';
export * from './space';
export * from './milestone';
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @us-os/shared-types test`
Expected: PASS, all `milestone.test.ts` cases green.

- [x] **Step 5: Commit**

```bash
git add packages/shared-types/src/milestone.ts packages/shared-types/src/milestone.test.ts packages/shared-types/src/index.ts
git commit -m "feat(shared-types): add milestone request/response Zod schemas"
```

---

### Task 2: Extend the `Milestone` Prisma model and migrate the database

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/<timestamp>_update_milestone_timeline_fields/migration.sql` (timestamp assigned by Prisma when you run the command in Step 1 — do not hand-pick it)
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/test/rls.integration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: Prisma `Milestone` model with fields `id, spaceId, createdBy, title, eventDate (Date), category (string), noteCiphertext, noteIv, noteAuthTag, noteVersion, createdAt, updatedAt` — consumed by Task 4's `MilestonesService`. `Milestone` type now exported from `@us-os/database` for use in `apps/api`.

- [x] **Step 1: Update the Prisma schema**

In `packages/database/prisma/schema.prisma`, replace the existing `Milestone` model with:

```prisma
model Milestone {
  id             String    @id @default(uuid()) @db.Uuid
  spaceId        String    @map("space_id") @db.Uuid
  createdBy      String    @map("created_by") @db.Uuid
  title          String
  eventDate      DateTime  @map("event_date") @db.Date
  category       String    @default("other")
  noteCiphertext String?   @map("note_ciphertext")
  noteIv         String?   @map("note_iv")
  noteAuthTag    String?   @map("note_auth_tag")
  noteVersion    Int?      @map("note_version") @default(1)
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  space   Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  creator User  @relation(fields: [createdBy], references: [id])

  @@index([spaceId])
  @@map("milestones")
}
```

And add the back-relation to the `User` model (insert after the `memberships` field):

```prisma
model User {
  id           String   @id @default(uuid()) @db.Uuid
  email        String   @unique
  passwordHash String   @map("password_hash")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  memberships       SpaceMembership[]
  createdMilestones Milestone[]

  @@map("users")
}
```

- [x] **Step 2: Generate an empty migration to hand-write**

Run: `pnpm --filter @us-os/database exec prisma migrate dev --create-only --name update_milestone_timeline_fields`

This creates a new folder under `packages/database/prisma/migrations/` without applying it. Prisma's auto-generated SQL in that folder will likely try to `DROP COLUMN occurred_at` / `ADD COLUMN event_date` (destructive rename modeled as drop+add) — discard whatever it generated.

- [x] **Step 3: Replace the generated migration.sql with a hand-written rename-and-extend migration**

Replace the full contents of the new `migration.sql` file with:

```sql
-- Rename occurred_at -> event_date and narrow its type to DATE (existing rows
-- are RLS-phase proof-of-concept data only, not real user content).
ALTER TABLE "milestones" RENAME COLUMN "occurred_at" TO "event_date";
ALTER TABLE "milestones" ALTER COLUMN "event_date" TYPE DATE USING ("event_date"::date);

-- New columns for FR-02 (Life Timeline & Event Ledger Engine)
ALTER TABLE "milestones" ADD COLUMN "created_by" UUID;
ALTER TABLE "milestones" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "milestones" ADD COLUMN "note_ciphertext" TEXT;
ALTER TABLE "milestones" ADD COLUMN "note_iv" TEXT;
ALTER TABLE "milestones" ADD COLUMN "note_auth_tag" TEXT;
ALTER TABLE "milestones" ADD COLUMN "note_version" INTEGER DEFAULT 1;

-- created_by is a required FK with no default. No real milestone rows exist
-- yet (RLS-phase proof-of-concept data only), so clearing the table before
-- enforcing NOT NULL is safe -- if you have local dev/seed rows you care
-- about, back them up before running this migration.
DELETE FROM "milestones";
ALTER TABLE "milestones" ALTER COLUMN "created_by" SET NOT NULL;

ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The existing RLS policy (see 20260728161552_add_space_and_milestone) is
-- row-level, not column-level, and needs no changes for these new columns.
```

- [x] **Step 4: Apply the migration**

Run: `pnpm db:migrate`

Expected: the pending migration applies cleanly against the local Postgres from `docker-compose.yml` (must be running: `docker compose up -d postgres`).

- [x] **Step 5: Regenerate the Prisma client and export the `Milestone` type**

Run: `pnpm db:generate`

Update `packages/database/src/index.ts`:

```ts
export * from './client';
export * from './tenant-context';
export { Prisma } from '@prisma/client';
export type { Space, User, SpaceMembership, PairingCode, Milestone } from '@prisma/client';
```

(No change needed to `TENANT_SCOPED_MODELS` in `packages/database/src/client.ts` — `'Milestone'` is already in that `Set`.)

- [x] **Step 6: Update the existing RLS integration test for the new required `createdBy` field and renamed `eventDate` column**

Replace the full contents of `packages/database/test/rls.integration.test.ts`:

```ts
import { prisma, withTenantTransaction } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Space B' } });
    userA = await prisma.user.create({
      data: { email: `rls-a-${Date.now()}@example.com`, passwordHash: 'x' },
    });
    userB = await prisma.user.create({
      data: { email: `rls-b-${Date.now()}@example.com`, passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    // Spaces first: deleting them cascades their milestones, which is a
    // prerequisite for deleting the users below (created_by is a
    // RESTRICT-on-delete FK).
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.user.delete({ where: { id: userB.id } });
    await prisma.$disconnect();
  });

  it('isolates milestones between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.milestone.create({
        data: { spaceId: spaceA.id, createdBy: userA.id, title: 'A milestone', eventDate: new Date() },
      }),
    );
    await TenantContext.run(spaceB.id, () =>
      prisma.milestone.create({
        data: { spaceId: spaceB.id, createdBy: userB.id, title: 'B milestone', eventDate: new Date() },
      }),
    );

    const seenFromA = await TenantContext.run(spaceA.id, () => prisma.milestone.findMany());
    const seenFromB = await TenantContext.run(spaceB.id, () => prisma.milestone.findMany());

    expect(seenFromA.map((m) => m.title)).toEqual(['A milestone']);
    expect(seenFromB.map((m) => m.title)).toEqual(['B milestone']);
  });

  it('throws before issuing SQL when no TenantContext is set', async () => {
    await expect(prisma.milestone.findMany()).rejects.toThrow(
      'TenantContext: no space set for Milestone.findMany',
    );
  });

  it('rejects a cross-tenant write at the database level', async () => {
    await expect(
      TenantContext.run(spaceA.id, () =>
        prisma.milestone.create({
          data: { spaceId: spaceB.id, createdBy: userA.id, title: 'sneaky', eventDate: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it('fails closed (zero rows) when the session variable is an empty string', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_space_id', '', true)`;
      const rows = await tx.milestone.findMany();
      expect(rows).toEqual([]);
    });
  });

  it('rolls back all writes in withTenantTransaction if one fails', async () => {
    const before = await TenantContext.run(spaceA.id, () => prisma.milestone.count());

    await expect(
      TenantContext.run(spaceA.id, () =>
        withTenantTransaction(async (tx) => {
          await tx.milestone.create({
            data: { spaceId: spaceA.id, createdBy: userA.id, title: 'will be rolled back', eventDate: new Date() },
          });
          // Second write in the same atomic operation fails (foreign spaceId, WITH CHECK rejects it).
          await tx.milestone.create({
            data: { spaceId: spaceB.id, createdBy: userA.id, title: 'invalid', eventDate: new Date() },
          });
        }),
      ),
    ).rejects.toThrow();

    const after = await TenantContext.run(spaceA.id, () => prisma.milestone.count());
    expect(after).toBe(before);
  });

  it('reuses the active transaction when withTenantTransaction is nested, rather than opening a second one', async () => {
    let innerTx: unknown;
    let outerTx: unknown;

    await TenantContext.run(spaceA.id, () =>
      withTenantTransaction(async (tx) => {
        outerTx = tx;
        await withTenantTransaction(async (nestedTx) => {
          innerTx = nestedTx;
        });
      }),
    );

    expect(innerTx === outerTx).toBe(true);
  });

  it('rolls back the outer transaction when a nested withTenantTransaction call fails', async () => {
    const before = await TenantContext.run(spaceA.id, () => prisma.milestone.count());

    await expect(
      TenantContext.run(spaceA.id, () =>
        withTenantTransaction(async (outerTx) => {
          await outerTx.milestone.create({
            data: { spaceId: spaceA.id, createdBy: userA.id, title: 'outer write', eventDate: new Date() },
          });
          // Nested call reuses the outer transaction, so its failure rolls back
          // the outer write above too, not just its own.
          await withTenantTransaction(async (innerTx) => {
            await innerTx.milestone.create({
              data: { spaceId: spaceB.id, createdBy: userA.id, title: 'invalid nested write', eventDate: new Date() },
            });
          });
        }),
      ),
    ).rejects.toThrow();

    const after = await TenantContext.run(spaceA.id, () => prisma.milestone.count());
    expect(after).toBe(before);
  });
});
```

- [x] **Step 7: Run the database package tests to verify they pass**

Run: `pnpm --filter @us-os/database test`
Expected: PASS (requires local Postgres running with `DATABASE_URL`/`APP_DATABASE_URL` set — see `docker-compose.yml`).

- [x] **Step 8: Run typecheck across the workspace**

Run: `pnpm typecheck`
Expected: PASS — no other file references the old `occurredAt` field (only the RLS test did, already updated in Step 6).

- [x] **Step 9: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations packages/database/src/index.ts packages/database/test/rls.integration.test.ts
git commit -m "feat(database): extend Milestone with category, attribution, and encrypted-note columns"
```

---

### Task 3: `CryptoModule` / `CryptoService` for AES-256-GCM note encryption

**Files:**
- Create: `apps/api/src/crypto/crypto.service.ts`
- Create: `apps/api/src/crypto/crypto.service.spec.ts`
- Create: `apps/api/src/crypto/crypto.module.ts`

**Interfaces:**
- Produces: `CryptoService.encryptNote(plaintext: string): EncryptedNote` and `CryptoService.decryptNote(input: EncryptedNote): string`, where `EncryptedNote = { ciphertext: string; iv: string; authTag: string }` (all base64 strings) — consumed by Task 4's `MilestonesService`. `CryptoModule` exports `CryptoService`.

- [x] **Step 1: Write the failing tests**

Create `apps/api/src/crypto/crypto.service.spec.ts`:

```ts
const VALID_KEY = 'VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs=';

describe('CryptoService', () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    jest.resetModules();
  });

  afterAll(() => {
    process.env.ENCRYPTION_MASTER_KEY = originalKey;
  });

  it('round-trips a plaintext note', () => {
    const { CryptoService } = require('./crypto.service');
    const service = new CryptoService();
    const encrypted = service.encryptNote('We moved in together');
    expect(service.decryptNote(encrypted)).toBe('We moved in together');
  });

  it('produces a different iv and ciphertext on each call for the same plaintext', () => {
    const { CryptoService } = require('./crypto.service');
    const service = new CryptoService();
    const first = service.encryptNote('same text');
    const second = service.encryptNote('same text');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('throws when decrypting with a tampered auth tag', () => {
    const { CryptoService } = require('./crypto.service');
    const service = new CryptoService();
    const encrypted = service.encryptNote('sensitive');
    const tampered = { ...encrypted, authTag: Buffer.from('0'.repeat(16)).toString('base64') };
    expect(() => service.decryptNote(tampered)).toThrow();
  });

  it('refuses to load when ENCRYPTION_MASTER_KEY is missing', () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    expect(() => require('./crypto.service')).toThrow('ENCRYPTION_MASTER_KEY must be a valid base64 string');
  });

  it('refuses to load when ENCRYPTION_MASTER_KEY does not decode to exactly 32 bytes', () => {
    process.env.ENCRYPTION_MASTER_KEY = Buffer.from('too short').toString('base64');
    expect(() => require('./crypto.service')).toThrow('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- crypto.service`
Expected: FAIL — `Cannot find module './crypto.service'`

- [x] **Step 3: Implement `CryptoService`**

Create `apps/api/src/crypto/crypto.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface EncryptedNote {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function loadMasterKey(): Buffer {
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw || !BASE64_PATTERN.test(raw)) {
    throw new Error('ENCRYPTION_MASTER_KEY must be a valid base64 string');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  }
  return key;
}

// Loaded once at module import time (same fail-fast-at-boot pattern as
// JWT_SECRET in session.service.ts) so a bad key surfaces immediately on
// startup, never on the first note write.
const MASTER_KEY = loadMasterKey();

@Injectable()
export class CryptoService {
  encryptNote(plaintext: string): EncryptedNote {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decryptNote({ ciphertext, iv, authTag }: EncryptedNote): string {
    const decipher = createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
```

Create `apps/api/src/crypto/crypto.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm --filter @us-os/api test -- crypto.service`
Expected: PASS, all 5 cases green.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/crypto
git commit -m "feat(api): add CryptoModule for AES-256-GCM note encryption"
```

---

### Task 4: `MilestonesModule` — controller, service, and happy-path integration tests

**Files:**
- Create: `apps/api/src/milestones/require-space.ts`
- Create: `apps/api/src/milestones/milestones.service.ts`
- Create: `apps/api/src/milestones/milestones.controller.ts`
- Create: `apps/api/src/milestones/milestones.controller.spec.ts`
- Create: `apps/api/src/milestones/milestones.module.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `CryptoService` (Task 3), `CreateMilestoneRequestSchema`/`UpdateMilestoneRequestSchema`/`MilestoneResponse` (Task 1), `AuthenticatedUser` (`apps/api/src/auth/types.ts`), `JwtAuthGuard` (`apps/api/src/auth/jwt-auth.guard.ts`), `createZodValidationPipe` (`apps/api/src/common/zod-validation.pipe.ts`), `prisma` (`@us-os/database`).
- Produces: `requireSpaceId(spaceId: string | null): string` (throws `ConflictException` if null), `MilestonesService` with `list()`, `create(spaceId, userId, dto)`, `update(id, dto)`, `remove(id)` methods, `MilestonesController` mounted at `/milestones` — consumed by Task 5 and Task 6's additional tests and Task 8's frontend.

- [x] **Step 1: Write the failing happy-path integration tests**

Create `apps/api/src/milestones/milestones.controller.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SpacesModule } from '../spaces/spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { MilestonesModule } from './milestones.module';

describe('MilestonesController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerWithSpace(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `milestones-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  it('creates a milestone without a note', async () => {
    const { cookie } = await registerWithSpace('create-basic');

    const res = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'First apartment', eventDate: '2024-03-15', category: 'milestone' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('First apartment');
    expect(res.body.eventDate).toBe('2024-03-15');
    expect(res.body.note).toBeNull();
  });

  it('lists milestones oldest-first by eventDate', async () => {
    const { cookie } = await registerWithSpace('list-order');

    await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Second', eventDate: '2024-06-01' });
    await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'First', eventDate: '2024-01-01' });

    const res = await request(app.getHttpServer()).get('/milestones').set('Cookie', cookie);

    expect(res.body.map((m: { title: string }) => m.title)).toEqual(['First', 'Second']);
  });

  it('updates a milestone', async () => {
    const { cookie } = await registerWithSpace('update-basic');
    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Original', eventDate: '2024-01-01' });

    const res = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
  });

  it('deletes a milestone', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'To delete', eventDate: '2024-01-01' });

    const deleteRes = await request(app.getHttpServer())
      .delete(`/milestones/${created.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/milestones').set('Cookie', cookie);
    expect(listRes.body.map((m: { id: string }) => m.id)).not.toContain(created.body.id);
  });

  it('rejects requests without a session cookie with 401', async () => {
    const res = await request(app.getHttpServer()).get('/milestones');
    expect(res.status).toBe(401);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm --filter @us-os/api test -- milestones.controller`
Expected: FAIL — `Cannot find module './milestones.module'`

- [x] **Step 3: Implement the module**

Create `apps/api/src/milestones/require-space.ts`:

```ts
import { ConflictException } from '@nestjs/common';

export function requireSpaceId(spaceId: string | null): string {
  if (!spaceId) {
    throw new ConflictException('You must create or join a Space before using the timeline');
  }
  return spaceId;
}
```

Create `apps/api/src/milestones/milestones.service.ts`:

```ts
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
```

Create `apps/api/src/milestones/milestones.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import {
  CreateMilestoneRequestSchema,
  UpdateMilestoneRequestSchema,
  type CreateMilestoneRequest,
  type UpdateMilestoneRequest,
} from '@us-os/shared-types';
import type { Request } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import { requireSpaceId } from './require-space';
import { MilestonesService } from './milestones.service';

@UseGuards(JwtAuthGuard)
@Controller('milestones')
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

  @Get()
  async list(@Req() req: Request) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.milestonesService.list();
  }

  @Post()
  @UsePipes(createZodValidationPipe(CreateMilestoneRequestSchema))
  async create(@Req() req: Request, @Body() dto: CreateMilestoneRequest) {
    const { userId, spaceId } = req.user as AuthenticatedUser;
    const scopedSpaceId = requireSpaceId(spaceId);
    return this.milestonesService.create(scopedSpaceId, userId, dto);
  }

  @Patch(':id')
  @UsePipes(createZodValidationPipe(UpdateMilestoneRequestSchema))
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateMilestoneRequest) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    return this.milestonesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const { spaceId } = req.user as AuthenticatedUser;
    requireSpaceId(spaceId);
    await this.milestonesService.remove(id);
  }
}
```

Create `apps/api/src/milestones/milestones.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [MilestonesController],
  providers: [MilestonesService],
})
export class MilestonesModule {}
```

Update `apps/api/src/app.module.ts` to register the module:

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { MilestonesModule } from './milestones/milestones.module';
import { SessionModule } from './session/session.module';
import { SpacesModule } from './spaces/spaces.module';
import { TenantMiddleware } from './tenant/tenant.middleware';

@Module({
  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('*');
    consumer.apply(TenantMiddleware).exclude('health').forRoutes('*');
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm --filter @us-os/api test -- milestones.controller`
Expected: PASS, all 5 cases green. (Requires local Postgres running.)

- [x] **Step 5: Commit**

```bash
git add apps/api/src/milestones apps/api/src/app.module.ts
git commit -m "feat(api): add MilestonesModule with CRUD endpoints"
```

---

### Task 5: Note encryption behavior — round-trip, whitespace normalization, three-state PATCH, decryption-failure resilience

**Files:**
- Modify: `apps/api/src/milestones/milestones.controller.spec.ts` (append test cases; no service/controller changes — this task hardens coverage of behavior already implemented in Task 4)

**Interfaces:**
- Consumes: `MilestonesService`/`MilestonesController` (Task 4), `prisma` + `TenantContext` (`@us-os/database`) for direct DB inspection/corruption.

- [x] **Step 1: Write the failing tests**

Append to `apps/api/src/milestones/milestones.controller.spec.ts`, inside the existing `describe` block (add this import at the top of the file alongside the others: `import { TenantContext } from '@us-os/database';`):

```ts
  it('round-trips a note and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('note-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'First apartment', eventDate: '2024-03-15', note: 'We moved in together' });

    expect(created.body.note).toBe('We moved in together');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () =>
      prisma.milestone.findFirstOrThrow({ where: { id: created.body.id } }),
    );
    expect(rawRow.noteCiphertext).not.toBeNull();
    expect(rawRow.noteCiphertext).not.toContain('We moved in together');
  });

  it('normalizes a whitespace-only note to null on create', async () => {
    const { cookie } = await registerWithSpace('note-whitespace-create');

    const res = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', note: '   ' });

    expect(res.body.note).toBeNull();
  });

  it('PATCH note: "text" re-encrypts, null clears, omitted leaves untouched', async () => {
    const { cookie } = await registerWithSpace('note-three-state');
    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', note: 'original note' });

    const reencrypted = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ note: 'new text' });
    expect(reencrypted.body.note).toBe('new text');

    const untouched = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'renamed only' });
    expect(untouched.body.note).toBe('new text');

    const cleared = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ note: null });
    expect(cleared.body.note).toBeNull();

    const clearedByWhitespace = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'y', eventDate: '2024-01-01', note: 'has a note' });
    const clearedRes = await request(app.getHttpServer())
      .patch(`/milestones/${clearedByWhitespace.body.id}`)
      .set('Cookie', cookie)
      .send({ note: '   ' });
    expect(clearedRes.body.note).toBeNull();
  });

  it('recovers from a corrupted note: GET still returns 200 with note null, rest of list intact', async () => {
    const { cookie } = await registerWithSpace('note-corrupt');
    const good = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Good entry', eventDate: '2024-01-01', note: 'readable note' });
    const corrupted = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Corrupted entry', eventDate: '2024-02-01', note: 'will be corrupted' });

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    await TenantContext.run(spaceId, () =>
      prisma.milestone.update({
        where: { id: corrupted.body.id },
        data: { noteAuthTag: Buffer.from('0'.repeat(16)).toString('base64') },
      }),
    );

    const listRes = await request(app.getHttpServer()).get('/milestones').set('Cookie', cookie);
    expect(listRes.status).toBe(200);
    const byId = new Map(listRes.body.map((m: { id: string; note: string | null }) => [m.id, m.note]));
    expect(byId.get(corrupted.body.id)).toBeNull();
    expect(byId.get(good.body.id)).toBe('readable note');
  });
```

- [x] **Step 2: Run the tests to verify they fail (if any assertion is unmet) or pass immediately**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm --filter @us-os/api test -- milestones.controller`
Expected: PASS — Task 4's service already implements this behavior; this task is regression coverage. If anything fails, fix `milestones.service.ts` from Task 4 to match (do not weaken the test).

- [x] **Step 3: Commit**

```bash
git add apps/api/src/milestones/milestones.controller.spec.ts
git commit -m "test(api): cover milestone note encryption, whitespace normalization, and decryption-failure resilience"
```

---

### Task 6: Authorization, validation, and cross-space edge cases

**Files:**
- Modify: `apps/api/src/milestones/milestones.controller.spec.ts` (append test cases; no service/controller changes expected)

**Interfaces:**
- Consumes: `MilestonesService`/`MilestonesController` (Task 4).

- [x] **Step 1: Write the failing tests**

Append to the same `describe` block:

```ts
  it('either partner in the space may edit and delete an entry the other created', async () => {
    const creator = await registerWithSpace('either-partner-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `milestones-either-partner-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
      .post('/milestones')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator entry', eventDate: '2024-01-01' });

    const editByJoiner = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', joinerCookie)
      .send({ title: 'Edited by joiner' });
    expect(editByJoiner.status).toBe(200);
    expect(editByJoiner.body.createdBy).not.toBe(editByJoiner.body.id);

    const deleteByJoiner = await request(app.getHttpServer())
      .delete(`/milestones/${created.body.id}`)
      .set('Cookie', joinerCookie);
    expect(deleteByJoiner.status).toBe(204);
  });

  it('returns 404 (not 403) when updating or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookieA)
      .send({ title: 'Space A entry', eventDate: '2024-01-01' });

    const patchRes = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer())
      .delete(`/milestones/${created.body.id}`)
      .set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: '', eventDate: '2024-01-01' });
    expect(emptyTitle.status).toBe(400);

    const badCategory = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', category: 'vacation' });
    expect(badCategory.status).toBe(400);

    const badDate = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01T10:30:00Z' });
    expect(badDate.status).toBe(400);

    const noteTooLong = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', note: 'a'.repeat(10001) });
    expect(noteTooLong.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all four endpoints', async () => {
    const patchRes = await request(app.getHttpServer()).patch('/milestones/00000000-0000-0000-0000-000000000000');
    const deleteRes = await request(app.getHttpServer()).delete('/milestones/00000000-0000-0000-0000-000000000000');
    const postRes = await request(app.getHttpServer()).post('/milestones').send({});

    expect(patchRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
    expect(postRes.status).toBe(401);
  });
```

- [x] **Step 2: Run the tests to verify they pass**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm --filter @us-os/api test -- milestones.controller`
Expected: PASS — Task 4's implementation already handles these; this is regression coverage for authorization/validation edge cases. If anything fails, fix `milestones.service.ts`/`milestones.controller.ts` to match.

- [x] **Step 3: Run the full apps/api test suite once more**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm --filter @us-os/api test`
Expected: PASS, all suites green (auth, spaces, tenant, health, crypto, milestones).

- [x] **Step 4: Commit**

```bash
git add apps/api/src/milestones/milestones.controller.spec.ts
git commit -m "test(api): cover milestone authorization, cross-space isolation, and validation edge cases"
```

---

### Task 7: Wire `ENCRYPTION_MASTER_KEY` through local dev, turbo, and CI

**Files:**
- Modify: `turbo.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example` (repo root)
- Modify: `apps/api/.env.example`

**Interfaces:** none (env/config only).

- [x] **Step 1: Add `ENCRYPTION_MASTER_KEY` to turbo's `test` task env passthrough**

In `turbo.json`, update the `test` task:

```json
"test": {
  "dependsOn": ["^build"],
  "outputs": ["coverage/**"],
  "env": ["DATABASE_URL", "APP_DATABASE_URL", "ENCRYPTION_MASTER_KEY"]
}
```

- [x] **Step 2: Add the env var to CI**

In `.github/workflows/ci.yml`, add a line to the `env:` block already used for `DATABASE_URL`/`APP_DATABASE_URL` (same job, same block — this is a fixed dev/test key, not a real secret, checked in like the Postgres credentials above it):

```yaml
    env:
      DATABASE_URL: "postgresql://us_os:us_os_dev_password@localhost:5432/us_os_dev?schema=public"
      APP_DATABASE_URL: "postgresql://us_os_app:us_os_app_dev_password@localhost:5432/us_os_dev?schema=public"
      ENCRYPTION_MASTER_KEY: "VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs="
```

- [x] **Step 3: Document the env var for local dev**

Add this line (with a short comment) to both `.env.example` (repo root) and `apps/api/.env.example`, following the file's existing style:

```
# Base64-encoded 32-byte AES-256-GCM key for encrypting milestone notes at rest.
# Generate a real one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_MASTER_KEY=
```

- [x] **Step 4: Verify CI config is valid YAML and the full suite runs locally with the var set**

Run: `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm test`
Expected: PASS across all workspaces.

- [x] **Step 5: Commit**

```bash
git add turbo.json .github/workflows/ci.yml .env.example apps/api/.env.example
git commit -m "chore: wire ENCRYPTION_MASTER_KEY through turbo, CI, and env examples"
```

---

### Task 8: Minimal `/timeline` frontend page

**Files:**
- Create: `apps/web/app/timeline/page.tsx`

**Interfaces:**
- Consumes: `apiFetch` (`apps/web/lib/api.ts`), `MilestoneResponse`/`CreateMilestoneRequest`/`MilestoneCategory` (`@us-os/shared-types`), `AuthMeResponse` (`@us-os/shared-types`, already used by `login/page.tsx`).

- [x] **Step 1: Implement the page**

Create `apps/web/app/timeline/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse, MilestoneCategory, MilestoneResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

const CATEGORIES: MilestoneCategory[] = ['milestone', 'memory', 'decision', 'other'];

export default function TimelinePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<MilestoneResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [category, setCategory] = useState<MilestoneCategory>('other');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<MilestoneResponse[]>('/milestones'))
      .then(setEntries)
      .catch(() => router.push('/login'));
  }, [router]);

  function resetForm() {
    setTitle('');
    setEventDate('');
    setCategory('other');
    setNote('');
    setEditingId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        const updated = await apiFetch<MilestoneResponse>(`/milestones/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title, eventDate, category, note: note || null }),
        });
        setEntries((prev) => (prev ?? []).map((entry) => (entry.id === editingId ? updated : entry)));
      } else {
        const created = await apiFetch<MilestoneResponse>('/milestones', {
          method: 'POST',
          body: JSON.stringify({ title, eventDate, category, note: note || null }),
        });
        setEntries((prev) =>
          [...(prev ?? []), created].sort((a, b) => a.eventDate.localeCompare(b.eventDate)),
        );
      }
      resetForm();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function handleEdit(entry: MilestoneResponse) {
    setEditingId(entry.id);
    setTitle(entry.title);
    setEventDate(entry.eventDate);
    setCategory(entry.category);
    setNote(entry.note ?? '');
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this entry?')) return;
    setError(null);
    try {
      await apiFetch(`/milestones/${id}`, { method: 'DELETE' });
      setEntries((prev) => (prev ?? []).filter((entry) => entry.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (entries === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Timeline</h1>

      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <strong>{entry.title}</strong> — {entry.eventDate} ({entry.category})
            {entry.note && <p>{entry.note}</p>}
            <button type="button" onClick={() => handleEdit(entry)}>
              Edit
            </button>
            <button type="button" onClick={() => handleDelete(entry.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <h2>{editingId ? 'Edit entry' : 'Add entry'}</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Date <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Category{' '}
            <select value={category} onChange={(e) => setCategory(e.target.value as MilestoneCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <label>
            Note <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <button type="submit">{editingId ? 'Save' : 'Add entry'}</button>
        {editingId && (
          <button type="button" onClick={resetForm}>
            Cancel
          </button>
        )}
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
```

- [x] **Step 2: Typecheck the web app**

Run: `pnpm --filter @us-os/web typecheck`
Expected: PASS.

- [x] **Step 3: Manually verify in the browser**

Run: `docker compose up -d postgres redis`, then in one terminal `ENCRYPTION_MASTER_KEY=VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs= pnpm dev --filter=api`, in another `pnpm dev --filter=web`. Register a user, create a Space, navigate to `http://localhost:3000/timeline`, and confirm: the page redirects to `/login` when logged out; when logged in, you can add an entry with a note, see it listed, edit it, and delete it.

- [x] **Step 4: Commit**

```bash
git add apps/web/app/timeline/page.tsx
git commit -m "feat(web): add minimal /timeline page for the Life Timeline & Event Ledger"
```

---

## Self-Review Notes

- **Spec coverage:** data model + migration (Task 2), encryption module (Task 3), all four endpoints + response shape (Task 4), three-state PATCH semantics + decryption-failure resilience + raw-ciphertext check (Task 5), authorization/either-partner/cross-space-404/validation/401 (Task 6), startup key validation (Task 3), frontend page (Task 8), env wiring (Task 7). All 13 numbered testing-strategy items from the spec are covered across Tasks 2, 4, 5, and 6.
- **Non-goals respected:** no pagination, no soft delete, no optimistic locking, no rich text/media, no per-note envelope encryption, no `updatedBy` — none of these were introduced anywhere in the plan.
- **Deviation from the spec's literal wording, noted for the executor:** the spec mentions validating `ENCRYPTION_MASTER_KEY` with "`class-validator`, custom `IsBase64Key32Byte` constraint." This codebase has no `class-validator` anywhere (Zod + `createZodValidationPipe` is the established pattern for request DTOs, and startup env-var checks use a plain top-level throw — see `JWT_SECRET` in `session.service.ts`). Task 3 achieves the same fail-fast-at-boot guarantee with a plain function instead, to avoid introducing a second, inconsistent validation library for a single field.
- **Plan review (2026-07-29):** reviewed against RLS scoping, migration sequencing, and crypto test isolation. Only actionable finding: `MilestonesService.list()` relied on RLS scoping without a comment explaining it (unlike `findOrThrow`, which already had one) — fixed in Task 4 by adding a matching comment. Migration `DELETE`-before-`NOT NULL` sequencing and the Jest `jest.resetModules()`/`afterAll` pattern in Task 3's crypto tests were both reviewed and confirmed correct as written; no changes needed.

## Execution Log (2026-07-29 / 2026-07-30)

All 8 tasks implemented and committed on `fr-02-life-timeline-event-ledger-engine`, PR #11, merged into CI green (`Build & Test` + `Secret Scanning` both pass).

**Deviations from the plan, found and fixed during execution (all necessary — the plan's literal text would not have worked as written):**

1. **`apps/api/src/tenant/tenant-integration.spec.ts`** (pre-existing file, not listed in Task 2's file list) still referenced the old `occurredAt` column and lacked the now-required `createdBy` field — updated alongside Task 2's migration, or `pnpm typecheck` fails.
2. **Task 4's integration test never wires `TenantMiddleware`.** `Milestone` is a tenant-scoped Prisma model; without middleware setting `TenantContext` from the request's JWT cookie, every query throws `TenantContext: no space set`. The real app gets this from `AppModule.configure()`, which isn't part of the test's module graph (only individual modules are imported) — fixed by instantiating `TenantMiddleware` manually in `beforeAll`, mirroring `AppModule`'s wiring.
3. **Task 4's controller used method-level `@UsePipes` combined with `@Param('id')`.** `createZodValidationPipe` has no `ArgumentMetadata`-based filtering, so the method-level pipe also ran the body schema against the route's `id` string param, failing every PATCH with a spurious 400. Fixed by moving to parameter-scoped `@Body(pipe)` on `create()`/`update()`.
4. **Test cleanup FK ordering:** the controller spec's `afterAll` originally deleted users directly; `milestones.created_by` is a RESTRICT FK, so any test that created a milestone made user cleanup fail. Fixed by deleting the users' spaces first (cascades milestones/memberships), matching the pattern already used in `rls.integration.test.ts`.
5. **Task 7's file list names `apps/api/.env.example`, which doesn't exist in this repo.** The API's runtime env vars (`PORT`, `APP_DATABASE_URL`, etc.) live in the root `.env.example` — only that file was modified.
6. **CI-only lint failure (never caught locally because the plan's steps never run `pnpm lint`):** `crypto.service.spec.ts`'s `require()` calls (needed to reload the module fresh per test against a different `ENCRYPTION_MASTER_KEY`) tripped `@typescript-eslint/no-require-imports`. Fixed with scoped `eslint-disable-next-line` comments rather than a rule change, since the dynamic re-import is intentional, not accidental CJS usage. Pushed as a follow-up commit after the first CI run failed; the second run passed both `Build & Test` and `Secret Scanning`.

**Exit-criteria verification (2026-07-30), fresh evidence:**

- **"An event created via the frontend form correctly persists to PostgreSQL"** — confirmed with a real headless-browser session (Playwright/Chromium, installed ephemerally for this check, not added as a repo dependency): registered a user, created a Space, and submitted the `/timeline` "Add entry" form through actual DOM interaction (label-targeted fills + button clicks, not a simulated API call). Independently verified via a raw `psql` query against `milestones` (bypassing Prisma/the API entirely) that both submitted rows existed with the exact `event_date`/`category` values entered, and that the row with a note had `note_ciphertext IS NOT NULL` (proving encryption, not plaintext storage). Verification rows were deleted afterward.
- **"Events are returned and rendered in reverse-chronological order"** — this wording conflicts with the shipped and spec'd behavior, which is deliberately oldest-first ("life story order", `orderBy: [{ eventDate: 'asc' }, ...]`, spec.md L119-121). Per explicit human confirmation during this verification pass, the oldest-first behavior is correct and the criterion's wording was imprecise. Confirmed via the same browser session: after adding a second, earlier-dated entry, the rendered `<li>` order was `["Started dating (earlier)" (2020-01-01), "First apartment..." (2024-03-15)]` — ascending by `eventDate`, matching `milestones.controller.spec.ts`'s `lists milestones oldest-first by eventDate` test.
- **"Automated backend unit and integration tests pass cleanly (`pnpm test`)"** — verified with a forced, non-cached run (`turbo run test --force`, `0 cached, 5 total`, exit code 0): `@us-os/shared-types` 24/24, `@us-os/database` 13/13, `@us-os/api` 73/73 — 110/110 tests passing.
