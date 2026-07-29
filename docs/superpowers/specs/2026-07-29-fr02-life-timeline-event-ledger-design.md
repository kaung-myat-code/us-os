# FR-02: Life Timeline & Event Ledger Engine — Design

Date: 2026-07-29

## Overview

The RLS phase introduced a bare-bones `Milestone` model (`id`, `spaceId`,
`title`, `occurredAt`, timestamps) solely to prove tenant isolation
end-to-end. This phase turns it into the real timeline feature: encrypted
notes, a category enum, attribution, full CRUD, and a minimal clickable
frontend — the first user-facing feature built on top of FR-01's auth.

Scope: backend (`apps/api`, `packages/database`, `packages/shared-types`)
plus a minimal, unstyled frontend timeline view in `apps/web`, matching
FR-01's precedent. Visual polish, rich text, media attachments, and
pagination are explicitly out of scope (see Non-goals).

## Data model

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

`User` gains the required back-relation: `createdMilestones Milestone[]`
(no `@relation` name needed — only one relation exists between the two
models).

### Migration notes

This is **not** a purely additive migration:

- `occurred_at` (DateTime, full timestamp) is **renamed** to `event_date`
  and its type changed to `DATE` — truncating any existing time-of-day
  data. Acceptable: the only rows in existence are RLS-phase proof-of-concept
  test data, not real user content.
- `category`, `note_ciphertext`, `note_iv`, `note_auth_tag`, `note_version`
  are new nullable columns (`category` has a `NOT NULL DEFAULT 'other'`).
- `created_by` is a new **required** (`NOT NULL`) FK column with no default.
  Since no real milestone rows exist yet, this is safe; if dev/seed data
  exists locally it must be cleared or backfilled before running the
  migration.
- The existing RLS policy on `milestones` needs no changes — it is
  row-level, not column-level, and continues to apply unchanged.

### Note field invariant

The four `note*` columns are populated as a group or all left `null` —
never a partial state. An empty string or whitespace-only note is
normalized to `null` before it ever reaches the crypto layer (see API
surface).

`createdBy` is informational attribution ("who recorded this memory"),
**not** an authorization gate — either partner may edit or delete any
entry in their shared space (see Authorization).

## Encryption

New NestJS module `apps/api/src/crypto/` (`CryptoModule` / `CryptoService`)
— not in `packages/database`, which stays a framework-agnostic Prisma
wrapper. `CryptoModule` is exported so any future module needing
encryption (e.g. a later journal feature) can import it independently of
the milestones module.

- **Direct master-key encryption** (no per-note DEK / envelope layer).
  `ENCRYPTION_MASTER_KEY` env var, base64-encoded 32-byte key, used
  directly with AES-256-GCM to encrypt/decrypt the note. Satisfies
  CLAUDE.md's AES-256-GCM-at-rest requirement; full per-record envelope
  encryption (DEK wrapping) is deferred until there's an actual key
  rotation or per-user key scoping requirement — not needed with a single
  master key today.
- `CryptoService.encryptNote(plaintext): { ciphertext, iv, authTag }` /
  `decryptNote({ ciphertext, iv, authTag }): string`. IV is a random 12
  bytes per call, generated with Node's `crypto` module, never reused.
- `noteVersion` (default `1`) is stored per-row so a future algorithm/key
  change has an explicit marker for which decryption path a given row
  needs — the service doesn't have to infer it from column presence.
- **Startup validation**: `ENCRYPTION_MASTER_KEY` is validated at NestJS
  bootstrap (`class-validator`, custom `IsBase64Key32Byte` constraint) —
  must be valid base64 decoding to exactly 32 bytes, or the app refuses to
  start. No silent degradation, no runtime surprise on first note write.
- **Decryption failure handling**: if decrypting a single note throws
  (e.g. a future key rotation invalidates old ciphertext), the entry is
  still returned with `note: null` and a server-side warning logged — one
  corrupted/unreadable note must not fail the entire `GET /milestones`
  response.
- Ciphertext columns are **never** serialized into an API response — the
  decrypted `note` string replaces them; `noteCiphertext`/`noteIv`/
  `noteAuthTag`/`noteVersion` are stripped before the response leaves the
  service layer.

## API surface

`apps/api/src/milestones` (module name kept as `milestones`, not renamed
to `timeline` — avoids churn in the RLS policy/model name already
established by the prior phase). All error responses use RFC 7807.
Auth: JWT-guarded (`PassportJwtStrategy`), space scope comes implicitly
from `TenantMiddleware`/RLS — routes are `/milestones`, not
`/spaces/:spaceId/milestones`.

- **`GET /milestones`** → `200`, bare array, sorted
  `orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }]` (oldest first —
  "life story" order), no pagination (full dataset returned every time).
- **`POST /milestones`** → `201`, bare created object.
  Body: `{ title, eventDate, category?, note? }`. `createdBy` is
  server-set from `req.user.id`, never client-provided.
- **`PATCH /milestones/:id`** → `200`, bare updated object. Partial
  update, any subset of `{ title, eventDate, category, note }`.
- **`DELETE /milestones/:id`** → `204`, no body. Hard delete.

### Response shape

```jsonc
// GET /milestones — 200
[
  {
    "id": "uuid",
    "title": "First apartment",
    "eventDate": "2024-03-15",       // date-only, no time
    "category": "milestone",
    "note": "We moved in together",  // decrypted, or null
    "createdBy": "uuid",             // partner's user id, not resolved to name
    "createdAt": "2024-03-15T10:30:00Z",
    "updatedAt": "2024-03-15T10:30:00Z"
  }
]
```

`POST`/`PATCH` return the same single-object shape. `createdBy` is
returned as a raw UUID, not resolved to a name — the frontend resolves
"recorded by" display text from its own session/partner context, avoiding
an extra join on every list query.

### PATCH `note` semantics (three states)

| Body | Effect |
|---|---|
| `"note": "text"` | Trimmed; if non-empty, encrypt and set all four columns |
| `"note": ""` or `"note": "   "` | Treated as `null` — clears the note (all four columns → `null`), no encryption performed |
| `"note": null` | Explicitly clears the note (all four columns → `null`) |
| `note` key absent from body | Existing note left untouched |

Zod schema uses `z.string().max(10000).nullable().optional()` —
`.nullable()` and `.optional()` together are what let the service
distinguish "explicit null" (clear) from "key absent" (leave alone); a
bare `.optional()` would collapse both to `undefined` and silently break
the "clear" case. Same trim-to-null normalization applies on `POST`.

Applies the same way on create: `POST` with an empty/whitespace `note` is
equivalent to omitting it — columns stay `null`.

### Validation limits (Zod, `packages/shared-types`)

| Field | Rule |
|---|---|
| `title` | `min(1).max(500)` |
| `eventDate` | `YYYY-MM-DD` regex — date-only, rejects a full datetime string |
| `category` | `z.enum(['milestone', 'memory', 'decision', 'other']).default('other')` |
| `note` | `max(10000).nullable().optional()`, trimmed-to-null if empty/whitespace |

### Authorization

No per-entry ownership check. RLS already scopes every query to the
caller's space; either partner may edit/delete any entry in that space.
`findUnique({ where: { id, spaceId } })` returning `null` (row belongs to
another space, invisible under RLS, or doesn't exist) maps to `404` —
never `403`, since the row is architecturally invisible, not merely
forbidden.

### Concurrency

No optimistic locking / conflict detection. Concurrent edits are
resolved **last-write-wins** — acceptable for v1 given the low likelihood
of two partners editing the same entry simultaneously in a 2-person
space.

## Error taxonomy

| Scenario | Status |
|---|---|
| `:id` not found / not in caller's space | `404` |
| Validation failure (empty title, bad date format, bad category, note too long) | `400` |
| No JWT / expired | `401` |
| No tenant context (existing `TenantMiddleware` behavior, unchanged) | `400` |

## Frontend (minimal, unstyled — matches FR-01)

- `/timeline` — protected route (redirect to `/login` if `GET /auth/me`
  fails). Lists entries oldest→newest: title, date, category, decrypted
  note if present.
- Inline "add entry" form: title, date, category `<select>`, optional
  note `<textarea>` → `POST /milestones`.
- Each entry has Edit (loads values into the form, submits `PATCH`) and
  Delete (`DELETE`, confirms, removes from list) actions.
- No drag-reordering, no rich text, no media, no per-category
  color/icon styling — raw functional CRUD only.

## Testing strategy (integration, real Postgres via docker-compose, no mocks)

1. Create entry without note → all four note columns `null` in DB,
   `note: null` in response.
2. Create entry with note → round-trips correctly; raw DB row's
   `note_ciphertext` is not plaintext (proves encryption actually
   happened).
3. Create/PATCH with whitespace-only note (`"   "`) → normalized to
   `null`, same as omitting it.
4. List entries → sorted `eventDate asc, createdAt asc`; another space's
   entries are absent (RLS).
5. Update entry: `note: "new text"` re-encrypts; `note: null` clears all
   four columns; `note` omitted leaves existing note untouched — all
   three branches tested explicitly (highest-risk case).
6. `GET` returns `note: null` for null-column entries and the correct
   decrypted string for populated entries, in the same test.
7. Update/delete `:id` belonging to another space → `404`.
8. Delete entry → `204`; subsequent `GET` excludes it; row is actually
   removed from the DB (hard delete, not soft).
9. Validation: empty title → `400`; invalid category → `400`; malformed
   `eventDate` (e.g. full datetime string) → `400`; note over 10,000
   chars → `400`.
10. No JWT → `401` on all four endpoints.
11. `ENCRYPTION_MASTER_KEY` missing or wrong-length at boot → app fails
    to start (startup validation, not a per-request test).
12. Either-partner authorization: User A creates an entry, User B (same
    space) successfully edits and deletes it.
13. Decryption failure resilience: corrupt/mismatch a note's ciphertext
    directly in the DB, then `GET /milestones` still returns `200` with
    that entry's `note: null` (not a 500), and the rest of the list
    intact.

## Non-goals / future work

- Rich text / markdown notes — plain string only.
- Tags / freeform labels beyond the four-value category enum.
- Media attachments (photos) — separate feature, needs R2/S3 integration.
- Pagination — full list returned every time; revisit if dataset size
  becomes a real concern.
- Soft delete / undo — hard delete only.
- Per-note or per-space envelope encryption (DEK wrapping) / key
  rotation — single master key only, for now.
- `updatedBy` audit trail — `updatedAt` timestamp only.
- Optimistic locking / conflict detection on concurrent edits.
- Frontend visual polish (icons/colors per category, responsive layout).
