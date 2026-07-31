# FR-03 & FR-04: Goals & Mutual Promises Engine — Design

Date: 2026-07-31

## Overview

Two sibling features tracking couples' shared commitments:

- **Goals (FR-03)**: long-term aspirational tracking with a manual progress
  percentage (e.g. "Save $50k for a down payment," "Run a marathon").
- **Mutual Promises (FR-04)**: discrete, one-time accountability commitments
  one partner makes to the other (e.g. "I'll book the flights by Friday").

Scope: backend (`apps/api`, `packages/database`, `packages/shared-types`)
plus minimal, unstyled frontend pages in `apps/web`, matching FR-01/FR-02/
FR-05 precedent.

Built as two separate, independent modules (`apps/api/src/goals` and
`apps/api/src/promises`) — they are conceptually distinct capabilities with
no data relationship between them, not a single combined feature. Both
follow the established FR-02/FR-05 pattern: RLS via `space_id`,
`CryptoService` for sensitive free-text fields, bare REST responses,
Zod validation, "architecturally invisible → 404, never 403" authorization,
last-write-wins concurrency (no optimistic locking).

## Data model

```prisma
model Goal {
  id          String    @id @default(uuid()) @db.Uuid
  spaceId     String    @map("space_id") @db.Uuid
  createdBy   String    @map("created_by") @db.Uuid
  title       String
  category    String    @default("other") // financial|health|travel|career|relationship|other
  targetDate  DateTime? @map("target_date") @db.Date
  progress    Int       @default(0)   // 0-100, manual
  status      String    @default("active") // active|achieved|abandoned
  achievedAt  DateTime? @map("achieved_at")
  descriptionCiphertext String? @map("description_ciphertext")
  descriptionIv          String? @map("description_iv")
  descriptionAuthTag     String? @map("description_auth_tag")
  descriptionVersion     Int?    @map("description_version") @default(1)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  space   Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  creator User  @relation(fields: [createdBy], references: [id])

  @@index([spaceId])
  @@map("goals")
}

model Promise {
  id          String    @id @default(uuid()) @db.Uuid
  spaceId     String    @map("space_id") @db.Uuid
  promisedBy  String    @map("promised_by") @db.Uuid
  title       String
  dueDate     DateTime? @map("due_date") @db.Date
  status      String    @default("pending") // pending|kept|broken
  resolvedAt  DateTime? @map("resolved_at")
  resolvedBy  String?   @map("resolved_by") @db.Uuid
  noteCiphertext String? @map("note_ciphertext")
  noteIv         String? @map("note_iv")
  noteAuthTag    String? @map("note_auth_tag")
  noteVersion    Int?    @map("note_version") @default(1)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  space    Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  promisor User  @relation(fields: [promisedBy], references: [id])
  resolver User? @relation(fields: [resolvedBy], references: [id])

  @@index([spaceId])
  @@map("promises")
}
```

`Space` gains `goals Goal[]`, `promises Promise[]` back-relations. `User`
gains `createdGoals Goal[]`, `promisedPromises Promise[]`,
`resolvedPromises Promise[]`.

Both tables get the standard `tenant_isolation` RLS policy (identical to
`decisions`/`milestones`):

```sql
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "goals"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);
-- identical policy on "promises"
```

No child tables — both models are flat, no denormalization concerns.

### Goal lifecycle

`status: 'active' | 'achieved' | 'abandoned'`. `progress` (0-100) and
`status` are **fully independent fields with no auto-sync or validation
coupling** — a goal can be `achieved` at 70% progress (scope was
intentionally reduced, e.g. "$35k was enough instead of $50k") or `active`
at 100% (hit the number, still deciding whether to call it done). Neither
state is rejected or auto-corrected.

`achievedAt` is set to `now()` whenever a `PATCH` transitions `status` to
`'achieved'`; left untouched on subsequent edits while still `achieved`;
cleared (`null`) if `status` moves away from `achieved`.

No sub-tasks or checklists — progress is a manually-entered percentage
only (see Non-goals).

### Promise lifecycle

`status: 'pending' | 'kept' | 'broken'`. Created via `POST` as `pending`
immediately — no accept/reject step; a promise is live as soon as it's
logged.

**`resolve`** (`PATCH /promises/:id/resolve`, `{ status: 'kept'|'broken', note? }`):
sets `status`, `resolvedAt: now()`, `resolvedBy: <caller>`. Either partner
may resolve — including the promisor themself — consistent with the
project's "either partner may act on shared data" model (no policing/
gatekeeping design). Re-resolving (already resolved, any status) is
allowed and overwrites `status`/`resolvedAt`/`resolvedBy` — including
resolving to the **same** status again, which succeeds as a no-op content-
wise but still refreshes `resolvedAt`/`resolvedBy` to the new caller/time.
No separate "reopen" endpoint; changing your mind is just another
`resolve` call. `outcomeNote`-equivalent (`note` on resolve) follows the
same replace-if-provided/leave-untouched-if-omitted semantics as FR-05's
`decide`.

No recurrence, no accept/reject gate, no Goal↔Promise link (see
Non-goals).

## Encryption

Reuses FR-02/FR-05's `CryptoService` unchanged. Two independently
encrypted fields:

- Goal **`description`** — free-text context, set at creation or via `PATCH`.
- Promise **`note`** — free-text context/reflection, set at creation, via
  `PATCH`, or via `resolve` (replaces if provided, preserved if omitted).

`title`, `category`, dates, `progress`, and `status` stay plaintext —
structured, needed for list rendering without per-cell decrypt cost.

## API surface

Both modules: JWT-guarded, space scope implicit via `TenantMiddleware`/RLS
(no `spaceId` in URLs). All error responses use RFC 7807.

### Goal routes

| Method & path | Status | Body | Notes |
|---|---|---|---|
| `GET /goals` | `200` | — | Bare array |
| `POST /goals` | `201` | `{ title, category?, targetDate?, description? }` | `createdBy` server-set |
| `GET /goals/:id` | `200` | — | Same shape as list item |
| `PATCH /goals/:id` | `200` | `{ title?, category?, targetDate?, progress?, status?, description? }` | Editable regardless of status |
| `DELETE /goals/:id` | `204` | — | |

### Promise routes

| Method & path | Status | Body | Notes |
|---|---|---|---|
| `GET /promises` | `200` | — | Bare array |
| `POST /promises` | `201` | `{ title, dueDate?, note? }` | `promisedBy` server-set to caller |
| `GET /promises/:id` | `200` | — | |
| `PATCH /promises/:id` | `200` | `{ title?, dueDate?, note? }` | Editable regardless of status |
| `PATCH /promises/:id/resolve` | `200` | `{ status: 'kept'\|'broken', note? }` | See lifecycle above |
| `DELETE /promises/:id` | `204` | — | |

### Response shapes

```jsonc
// GET /goals — 200, list
[
  {
    "id": "uuid",
    "title": "Save for a house down payment",
    "createdBy": "uuid",
    "category": "financial",
    "targetDate": "2027-06-01",
    "progress": 70,
    "status": "achieved",
    "achievedAt": "2026-07-20T09:00:00Z",
    "description": "Aiming for enough to avoid PMI",  // decrypted, or null
    "createdAt": "2026-01-10T10:30:00Z",
    "updatedAt": "2026-07-20T09:00:00Z"
  }
]
```

```jsonc
// GET /promises/:id — 200
{
  "id": "uuid",
  "title": "Book the flights",
  "promisedBy": "uuid",
  "dueDate": "2026-08-01",
  "status": "kept",
  "resolvedAt": "2026-07-30T18:00:00Z",
  "resolvedBy": "uuid",
  "note": "Booked the 6am flight, aisle seats",  // decrypted, or null
  "createdAt": "2026-07-25T12:00:00Z",
  "updatedAt": "2026-07-30T18:00:00Z"
}
```

`POST`/`PATCH`/`resolve` return the same single-object shape as `GET :id`.

### Validation (Zod, `packages/shared-types`)

| Field | Rule |
|---|---|
| Goal `title` | `min(1).max(200)` |
| Goal `category` | `z.enum(['financial','health','travel','career','relationship','other'])` |
| Goal `progress` | `z.number().int().min(0).max(100)` |
| Goal `status` | `z.enum(['active','achieved','abandoned'])` |
| Goal `description` | `max(10000).nullable().optional()`, trim-to-null if empty/whitespace |
| Goal `targetDate` | valid date, **no future-only restriction** — matches FR-02's unrestricted `eventDate`; backdating is allowed |
| Promise `title` | `min(1).max(200)` |
| Promise `note` | `max(10000).nullable().optional()`, trim-to-null — same limit as Goal `description`, intentional (no shorter cap for resolution notes) |
| Promise `dueDate` | valid date, **no future-only restriction**, same reasoning as `targetDate` |
| Promise `resolve.status` | `z.enum(['kept','broken'])` — `'pending'` is not a valid resolve target (no way to un-resolve back to pending) |

### Authorization

Same as FR-02/FR-05: no per-entry ownership check beyond `promisedBy`
being informational. Either partner may edit/delete/resolve anything in
the shared space. A row invisible under RLS (wrong space or nonexistent)
always maps to `404`, never `403`.

### Error taxonomy

| Scenario | Status |
|---|---|
| `:id` not found or not in caller's space | `404` |
| Validation failure | `400` |
| `resolve` with `status: 'pending'` | `400` |
| No JWT / expired | `401` |
| No tenant context (existing `TenantMiddleware` behavior) | `400` |

### Concurrency

No optimistic locking. Last-write-wins, same as FR-02/FR-05 — deliberately
not adding a `version` column despite it being raised in review, to stay
consistent with the rest of the app rather than introducing a new
concurrency model for just these two features.

## Frontend (minimal, unstyled — matches FR-01/FR-02/FR-05)

- **`/goals`** — protected route. Lists goals: title, category badge,
  progress (plain `<progress>` element or `"70%"` text), status badge,
  target date. Inline "new goal" form (title, category select, optional
  target date, optional description textarea) → `POST /goals`. Click into
  a goal for a detail view with an editable progress input/slider and a
  status dropdown, submitting `PATCH /goals/:id`.
- **`/promises`** — protected route. Lists promises: title, promisor name,
  due date, status badge. Inline "new promise" form (title, optional due
  date, optional note) → `POST /promises`. Each `pending` promise shows
  "Mark kept" / "Mark broken" buttons (either partner, including the
  promisor) with an optional note prompt, submitting
  `PATCH /promises/:id/resolve`. Resolved promises show resolved-by name
  and timestamp instead of the action buttons, plus a way to re-resolve
  (change the outcome).
- No charts, no category filter/sort, no due-date reminders/notifications,
  no confirmation modals beyond a basic `confirm()` on delete.

## Testing strategy (integration, real Postgres via docker-compose, no mocks)

1. Create goal without description → column `null`, `description: null` in
   response.
2. Create goal with description → round-trips; raw DB row's
   `description_ciphertext` is not plaintext.
3. List goals → excludes another space's goals (RLS); returns decrypted
   `description`.
4. Update goal `progress` and `status` independently in any combination
   (e.g. `progress: 100, status: 'active'` and `progress: 70,
   status: 'achieved'`) — both persist without cross-field rejection.
5. Transition goal `status` to `'achieved'` → `achievedAt` set; further
   edits while still achieved leave `achievedAt` unchanged; transition away
   from `achieved` → `achievedAt` cleared.
6. Delete a goal → row gone.
7. RLS isolation: `goals` and `promises` rows belonging to another space
   are invisible via direct query.
8. Create promise → `promisedBy` is the caller, `status: 'pending'`,
   `resolvedAt`/`resolvedBy` both `null`.
9. Resolve promise as `kept` → `status`, `resolvedAt`, `resolvedBy` set;
   note encrypted and round-trips.
10. A different partner (not the promisor) resolves the promise
    successfully — validates either-partner authorization.
11. Re-resolve an already-`kept` promise as `broken` → overwrites cleanly.
12. Re-resolve an already-`kept` promise as `kept` again (same status) →
    succeeds, refreshes `resolvedAt`/`resolvedBy`.
13. `resolve` with `status: 'pending'` → `400`.
14. Validation: empty title → `400`; invalid `category` → `400`; `progress`
    outside 0-100 → `400`; invalid goal `status` → `400`;
    description/note over max length → `400`.
15. No JWT → `401` on all endpoints for both modules.
16. Delete a promise → row gone.

## Non-goals / future work

- No sub-tasks/checklists on Goals — progress is a manual percentage only,
  not derived from completed steps.
- No recurring Promises — one-time commitments only; a habit/recurring-
  commitment tracker is a distinct future feature.
- No Goal↔Promise linking (no `goalId` FK on Promise).
- No accept/reject gate on Promise creation — live as `pending`
  immediately.
- No optimistic locking (`version` field) — last-write-wins throughout.
- No history of prior resolutions on Promise — each `resolve` call
  overwrites, matching FR-05's `decide`.
- No notifications/reminders for `targetDate`/`dueDate`.
- No charts, progress visualizations, or drag-reorder.
- Frontend visual polish (responsive layout, icons/colors).
