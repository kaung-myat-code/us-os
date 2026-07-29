# FR-05: Decision Framing Matrix Engine — Design

Date: 2026-07-30

## Overview

A structured decision-making tool for partners to evaluate complex life
choices (relocation, job offers, major purchases) by creating options,
assigning weighted pros/cons to each, computing a net score per option, and
logging (and later revising) the eventual outcome.

Scope: backend (`apps/api`, `packages/database`, `packages/shared-types`)
plus a minimal, unstyled frontend comparison view in `apps/web`, matching
FR-02's precedent. Visual polish, decision history/audit trail, and
cross-decision comparison are explicitly out of scope (see Non-goals).

Builds directly on FR-02's established patterns: `CryptoService` for
AES-256-GCM note encryption, RLS via `space_id` on every table, bare
array/object REST responses, "architecturally invisible → 404, never 403"
authorization.

## Data model

```prisma
model Decision {
  id                   String    @id @default(uuid()) @db.Uuid
  spaceId              String    @map("space_id") @db.Uuid
  createdBy            String    @map("created_by") @db.Uuid
  title                String
  status               String    @default("open") // "open" | "decided"
  chosenOptionId       String?   @map("chosen_option_id") @db.Uuid
  decidedAt            DateTime? @map("decided_at")
  rationaleCiphertext  String?   @map("rationale_ciphertext")
  rationaleIv          String?   @map("rationale_iv")
  rationaleAuthTag     String?   @map("rationale_auth_tag")
  rationaleVersion     Int?      @map("rationale_version") @default(1)
  outcomeCiphertext    String?   @map("outcome_ciphertext")
  outcomeIv            String?   @map("outcome_iv")
  outcomeAuthTag       String?   @map("outcome_auth_tag")
  outcomeVersion       Int?      @map("outcome_version") @default(1)
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @updatedAt @map("updated_at")

  space         Space           @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  creator       User            @relation(fields: [createdBy], references: [id])
  options       DecisionOption[]
  chosenOption  DecisionOption? @relation("ChosenOption", fields: [chosenOptionId], references: [id])

  @@index([spaceId])
  @@map("decisions")
}

model DecisionOption {
  id         String   @id @default(uuid()) @db.Uuid
  spaceId    String   @map("space_id") @db.Uuid   // denormalized for RLS
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
  spaceId   String   @map("space_id") @db.Uuid   // denormalized for RLS
  optionId  String   @map("option_id") @db.Uuid
  type      String   // "pro" | "con"
  label     String
  weight    Int      // 1-5
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  option DecisionOption @relation(fields: [optionId], references: [id], onDelete: Cascade)
  space  Space          @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  @@index([optionId])
  @@index([spaceId])
  @@map("trade_off_items")
}
```

`Space` gains `decisions Decision[]`, `decisionOptions DecisionOption[]`,
`tradeOffItems TradeOffItem[]` back-relations. `User` gains
`createdDecisions Decision[]`.

### Why `spaceId` is denormalized onto child tables

CLAUDE.md requires every query to be RLS-scoped on `space_id`. Rather than
relying on join-based access control for `DecisionOption`/`TradeOffItem`,
each gets its own direct `space_id` column and an identical
`tenant_isolation` RLS policy to `milestones`:

```sql
ALTER TABLE "decision_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_options" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "decision_options"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);
-- identical policy on "trade_off_items"
```

This guarantees uniform tenant isolation regardless of query entry point —
a direct query on `trade_off_items` is protected the same as one that joins
through `Decision`.

### Lifecycle

`status: 'open' | 'decided'`.

```
open  ──decide──▶  decided
  ▲                    │
  └──────reopen────────┘
        (decided → decided is also valid: re-deciding overwrites
         chosenOptionId/decidedAt without an intermediate reopen)
```

- **`decide`** (from `open` or `decided`): sets `status: 'decided'`,
  `chosenOptionId`, `decidedAt: now()`. If `outcomeNote` is provided
  (non-empty after trim), it replaces the encrypted outcome; if omitted,
  any existing outcome note is left untouched. Re-deciding (already
  `decided`) is allowed and simply overwrites the choice — no guard
  against it, since changing your mind before acting on a decision is a
  normal use case.
- **`reopen`** (from `decided` only — `400` if already `open`): clears
  `status` → `'open'`, `chosenOptionId` → `null`, `decidedAt` → `null`.
  **The outcome note is preserved**, not cleared — it has retrospective
  value ("we tried Austin, it didn't work out") even after reopening.
- No history of prior decided states is kept — each `decide` call
  overwrites the previous choice; only the current outcome note survives.

### Deletion guard

Deleting a `DecisionOption` that is the current `chosenOptionId` of a
`decided` Decision is blocked. The service pre-checks with
`prisma.decision.findFirst({ where: { chosenOptionId: optionId, spaceId } })`
before calling `delete`, returning a clean `400` naming the referencing
decision — rather than letting a raw FK constraint violation bubble up.

### Score computation

Never stored. Computed in the service layer on every detail read, from the
option's live `tradeOffs`:

```
score = Σ(weight where type = 'pro') − Σ(weight where type = 'con')
```

## Encryption

Reuses FR-02's `CryptoService` (`apps/api/src/crypto/`) unchanged — same
AES-256-GCM master-key scheme, same four-column-per-field pattern
(`*Ciphertext`, `*Iv`, `*AuthTag`, `*Version`), same trim-to-null-if-empty
normalization, same "never serialize ciphertext columns; decryption
failure returns `null` for that field with a server-side log, not a 500"
behavior.

Two independently encrypted fields on `Decision`:
- **`rationale`** — free-text context for the decision, set at creation or
  via `PATCH`.
- **`outcome`** — free-text reflection, set via `decide`, preserved across
  `reopen`.

`title`, option `label`s, and trade-off `label`s stay **plaintext** —
short, structured, needed for list/table rendering and score computation
without a per-cell decrypt cost.

## API surface

`apps/api/src/decisions` module. JWT-guarded, space scope implicit via
`TenantMiddleware`/RLS (no `spaceId` in URLs). All error responses use
RFC 7807.

### Decision routes

| Method & path | Status | Body | Notes |
|---|---|---|---|
| `GET /decisions` | `200` | — | Bare array, lightweight (no nested options) |
| `POST /decisions` | `201` | `{ title, rationale? }` | `createdBy` server-set |
| `GET /decisions/:id` | `200` | — | Full nested tree with computed `score` per option |
| `PATCH /decisions/:id` | `200` | `{ title?, rationale? }` | Editable regardless of status |
| `DELETE /decisions/:id` | `204` | — | Cascades options + tradeoffs |
| `PATCH /decisions/:id/decide` | `200` | `{ chosenOptionId, outcomeNote? }` | See lifecycle above |
| `PATCH /decisions/:id/reopen` | `200` | — | `400` if already `open` |

### Option routes (nested under decision)

| Method & path | Status | Body |
|---|---|---|
| `POST /decisions/:id/options` | `201` | `{ label }` |
| `PATCH /decisions/:id/options/:optionId` | `200` | `{ label }` |
| `DELETE /decisions/:id/options/:optionId` | `204` | — |

### Trade-off routes (nested under option)

| Method & path | Status | Body |
|---|---|---|
| `POST /decisions/:id/options/:optionId/tradeoffs` | `201` | `{ type, label, weight }` |
| `PATCH /decisions/:id/options/:optionId/tradeoffs/:tradeoffId` | `200` | `{ type?, label?, weight? }` |
| `DELETE /decisions/:id/options/:optionId/tradeoffs/:tradeoffId` | `204` | — |

Full nesting is used consistently for every route, including trade-offs —
even though `spaceId` denormalization would technically allow flattening
`PATCH`/`DELETE` trade-off routes to `/tradeoffs/:tradeoffId`, a single
consistent "everything lives under `/decisions`" convention is preferable
to a mixed nested/flat scheme.

### Response shapes

```jsonc
// GET /decisions — 200, list (lightweight, no nested children)
[
  {
    "id": "uuid",
    "title": "Where should we live?",
    "status": "open",
    "rationale": "We're outgrowing our apartment",  // decrypted, or null
    "decidedAt": null,
    "createdAt": "2024-03-15T10:30:00Z",
    "updatedAt": "2024-03-15T10:30:00Z"
    // no "outcomeNote" field — outcome is only ever visible via detail GET
  }
]
```

```jsonc
// GET /decisions/:id — 200, full detail
{
  "id": "uuid",
  "title": "Where should we live?",
  "status": "decided",
  "rationale": "We're outgrowing our apartment",
  "outcomeNote": "Chose Austin for the job market",  // decrypted, or null
  "chosenOptionId": "uuid",
  "decidedAt": "2024-04-01T09:00:00Z",
  "createdAt": "2024-03-15T10:30:00Z",
  "updatedAt": "2024-04-01T09:00:00Z",
  "options": [
    {
      "id": "uuid",
      "label": "Austin",
      "score": 2,
      "tradeOffs": [
        { "id": "uuid", "type": "pro", "label": "Job market", "weight": 5 },
        { "id": "uuid", "type": "con", "label": "Far from family", "weight": 3 }
      ]
    }
  ]
}
```

`POST`/`PATCH` on decisions, options, and tradeoffs return the same
single-object shape as their respective resource (decision `PATCH`/`decide`/
`reopen` return the detail shape including `options`; option/tradeoff
`POST`/`PATCH` return just that entity).

### Validation (Zod, `packages/shared-types`)

| Field | Rule |
|---|---|
| `title` | `min(1).max(200)` |
| `rationale` / `outcomeNote` | `max(10000).nullable().optional()`, trim-to-null if empty/whitespace (same three-state semantics as FR-02's `note`) |
| option `label` | `min(1).max(200)` |
| tradeoff `label` | `min(1).max(300)` |
| `type` | `z.enum(['pro', 'con'])` |
| `weight` | `z.number().int().min(1).max(5)` |
| `decide.chosenOptionId` | `z.string().uuid()`, **required** |

### Soft caps

`MAX_OPTIONS_PER_DECISION = 6`, `MAX_TRADEOFFS_PER_OPTION = 15`, defined as
named constants in the decisions module. Enforced in the service layer via
a `count()` query before insert, returning `400` if the cap would be
exceeded — not a DB-level constraint.

### Authorization

Same as FR-02: no per-entry ownership check. Either partner may edit/
delete anything in the shared space. A row invisible under RLS (wrong
space or nonexistent) always maps to `404`, never `403`.

### Error taxonomy

| Scenario | Status |
|---|---|
| `:id` / `:optionId` / `:tradeoffId` not found or not in caller's space | `404` |
| Validation failure | `400` |
| `decide` with `chosenOptionId` not belonging to the decision | `400` |
| `reopen` when already `open` | `400` |
| Delete option that is the chosen option of a `decided` decision | `400` |
| Option/trade-off count would exceed its soft cap | `400` |
| No JWT / expired | `401` |
| No tenant context (existing `TenantMiddleware` behavior) | `400` |

### Concurrency

No optimistic locking. Last-write-wins, same as FR-02.

## Frontend (minimal, unstyled — matches FR-01/FR-02)

- **`/decisions`** — protected route. Lists decisions: title, status
  badge, rationale preview. Inline "new decision" form (title + optional
  rationale textarea) → `POST /decisions`.
- **`/decisions/:id`** — comparison view:
  - Decision header: title, status badge, rationale.
  - Options rendered as stacked blocks (not columns — avoids responsive
    layout work for v1), up to 6. Each shows its label, a live-computed
    score, its trade-off list (type, label, weight, delete-per-item), and
    an inline "add tradeoff" form.
  - Score is computed **client-side** from the option's trade-off array in
    local state (`Σ(pro weights) − Σ(con weights)`, mirroring the service
    formula) — updates instantly on add/edit/delete with no server
    round-trip.
  - "Add option" inline form (label only), disabled/hidden at 6 options.
  - Lifecycle action, status-dependent: if `open`, a "Decide" control
    (select chosen option + optional outcome note) submitting
    `PATCH .../decide`; if `decided`, shows the chosen option and outcome
    note plus a "Reopen" button.
- No drag-reorder, no charts/visual score bars, no color coding, no
  confirmation modals beyond a basic `confirm()` on delete.

## Testing strategy (integration, real Postgres via docker-compose, no mocks)

1. Create decision without rationale → columns `null`, `rationale: null`
   in response.
2. Create decision with rationale → round-trips; raw DB row's
   `rationale_ciphertext` is not plaintext.
3. List decisions → excludes another space's decisions (RLS); returns
   decrypted `rationale`, no nested `options` field.
4. Get decision detail → returns nested options + tradeoffs with correctly
   computed `score` per option (mixed pros/cons; verify the arithmetic).
5. Add/edit/delete option and trade-off items → detail reflects changes;
   score recalculates correctly on next read (never stored, so no stale
   value is possible).
6. Exceeding `MAX_OPTIONS_PER_DECISION` (6) → `400`; exceeding
   `MAX_TRADEOFFS_PER_OPTION` (15) → `400`.
7. `decide` with valid `chosenOptionId` → status `decided`, `decidedAt`
   set, outcome encrypted and round-trips.
8. `decide` with `chosenOptionId` belonging to a *different* decision →
   `400`.
9. Re-decide an already-`decided` decision → overwrites `chosenOptionId`/
   `decidedAt`; omitting `outcomeNote` preserves the existing one;
   providing a new one replaces it.
10. `reopen` on `decided` → clears `status`/`chosenOptionId`/`decidedAt`;
    **outcome note untouched**.
11. `reopen` on already-`open` → `400`.
12. Delete an option that is the current `chosenOptionId` of a `decided`
    decision → `400`; decision and option both unchanged.
13. Delete a decision → cascades options and tradeoffs (verify child rows
    are actually gone from the DB, not just hidden).
14. RLS isolation: `DecisionOption`/`TradeOffItem` rows belonging to
    another space are invisible even via a direct query on their own
    table, not only when joined through `Decision` — validates the
    denormalized-`spaceId` architecture directly.
15. Validation: empty title → `400`; invalid `type` → `400`; `weight`
    outside 1–5 → `400`; label/rationale/outcome over max length → `400`.
16. No JWT → `401` on all endpoints.
17. Either-partner authorization: User A creates a decision and options,
    User B (same space) successfully adds tradeoffs, decides, and reopens
    it.
18. `GET /decisions` (list) response never includes an `outcomeNote` key —
    confirms the list/detail split holds at the response-shape level, not
    just for query performance.

## Non-goals / future work

- No `draft`/`archived` states — just `open`/`decided`.
- No history of past decided states — each `decide` overwrites the prior
  choice; only the current outcome note is retained.
- No decision templates or cross-decision comparison.
- No per-partner weighting (e.g. separate weight values per person) —
  a single shared weight per trade-off item.
- No notification to the other partner when a decision is created or
  decided — deferred explicitly to avoid scope creep during
  implementation.
- No visual score bars/charts, drag-reorder, or rich text.
- No optimistic locking / conflict detection on concurrent edits.
- Frontend visual polish (responsive column layout, icons/colors).
