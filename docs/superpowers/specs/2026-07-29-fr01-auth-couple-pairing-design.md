# FR-01: Auth Engine & Couple Pairing Protocol — Design

Date: 2026-07-29

## Overview

Relationship OS has no user accounts or auth yet — only `Space`/`Milestone`
with RLS tenant isolation keyed on `space_id` (see
`docs/superpowers/specs/2026-07-28-rls-tenant-isolation-design.md`). That
phase deliberately deferred auth, reading `space_id` from an `x-space-id`
header as a documented placeholder.

This phase builds real authentication (email + password, JWT-based sessions)
and the couple pairing protocol: a user creates a Space, generates a
short-lived pairing code, and their partner redeems it to join. This is the
first phase to introduce `User` accounts and space membership.

Scope: backend (`apps/api`, `packages/database`, `packages/shared-types`)
plus minimal, unstyled frontend forms in `apps/web` so the flow is
clickable end-to-end. Visual polish is explicitly out of scope.

## Membership model

Schema is genuinely many-to-many (`User` ↔ `Space` via `SpaceMembership`),
so relaxing the MVP constraint later needs no migration. For this phase,
business rules constrain it to:

- Each user may belong to **at most one Space** at a time.
- Each Space caps at **2 members**.

Enforced at two layers:
- **App layer**: service-level check before creating a membership row →
  `409 Conflict` "You're already part of a Space."
- **DB layer** (backstop): `CREATE UNIQUE INDEX ON space_memberships (user_id)`.
  A plain (non-partial) index is correct for this phase because there is no
  "leave a Space" feature yet, so every membership row is implicitly active.
  Future upgrade path, once "leave a Space" ships:
  ```sql
  DROP INDEX idx_one_membership_per_user;
  CREATE UNIQUE INDEX idx_one_active_membership_per_user
    ON space_memberships (user_id) WHERE left_at IS NULL;
  ```

## Data model

```prisma
model User {
  id           String   @id @default(uuid()) @db.Uuid
  email        String   @unique
  passwordHash String   @map("password_hash")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  memberships SpaceMembership[]
  @@map("users")
}

model SpaceMembership {
  id       String   @id @default(uuid()) @db.Uuid
  userId   String   @map("user_id") @db.Uuid
  spaceId  String   @map("space_id") @db.Uuid
  role     String   // 'creator' | 'member'
  joinedAt DateTime @default(now()) @map("joined_at")

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  space Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  @@unique([userId, spaceId])
  @@index([spaceId])
  @@map("space_memberships")
}

model PairingCode {
  id               String    @id @default(uuid()) @db.Uuid
  spaceId          String    @map("space_id") @db.Uuid
  code             String    @unique // 8-char alphanumeric
  expiresAt        DateTime  @map("expires_at")
  redeemedAt       DateTime? @map("redeemed_at")
  redeemedByUserId String?   @map("redeemed_by_user_id") @db.Uuid

  space Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  @@index([spaceId])
  @@map("pairing_codes")
}
```

`Space` gains back-relations (`memberships`, `pairingCodes`); no other change
to the `Space` model itself. Neither `SpaceMembership` nor `PairingCode` are
RLS-scoped (they're tenant-root/join tables, same as `Space`).

**PairingCode lifecycle**: reissuing a code deletes the prior unredeemed row
for that Space and creates a new one (only one active code per Space at a
time). A redeemed code's row is kept permanently — `redeemedAt` /
`redeemedByUserId` are the audit trail, never deleted.

## Auth mechanism

- Email + password. Passwords hashed with bcrypt.
- **Two Passport strategies**:
  - `PassportLocalStrategy` — validates email+password, runs only on
    `/auth/login` and `/auth/register`.
  - `PassportJwtStrategy` — extracts and verifies the JWT from the cookie,
    populates `req.user`, runs on every other protected route.
- JWT delivered as an **httpOnly, Secure, SameSite cookie** (not a
  client-stored token) — not accessible to JS, browser sends it
  automatically.
- Payload: `{ sub: "<user-id>", spaceId: "<space-id-or-null>" }`.
- Expiry: 7 days. No refresh-token rotation this phase — re-login after
  expiry. Refresh tokens are a non-goal (see below).

### JWT re-issuance

Every mutation that changes a user's space membership (create space, redeem
pairing code) ends by calling a shared `issueSessionCookie(res, user)`
helper: it reads the user's current membership from the DB and sets a fresh
cookie. This is the single source of truth for `spaceId` in the JWT — no
stale-JWT window between a membership change and the next request.

### Tenant middleware integration

`apps/api/src/tenant/tenant.middleware.ts` (built in the RLS phase) currently
reads `x-space-id` from a request header as a placeholder. This phase swaps
that read for `req.user.spaceId`, populated by the `PassportJwtStrategy`
guard. No new RLS interceptor — the existing `TenantContext` /
`withTenantTransaction` / RLS policy machinery is reused unchanged.

## API surface

All error responses use RFC 7807 Problem Details.

**Auth** (`apps/api/src/auth`)
- `POST /auth/register` — `{ email, password, pairingCode?: string }`.
  Creates `User`, hashes password, issues JWT cookie. If `pairingCode` is
  present, registration and code redemption happen atomically in one DB
  transaction — if the code is invalid, the whole registration rolls back
  (no orphaned `User` row). Otherwise issues a cookie with `spaceId: null`.
- `POST /auth/login` — Passport-Local guard, issues JWT cookie.
- `POST /auth/logout` — clears the cookie.
- `GET /auth/me` — Passport-JWT guard. Returns:
  ```json
  {
    "user": { "id": "...", "email": "...", "createdAt": "..." },
    "space": null | {
      "id": "...",
      "role": "creator" | "member",
      "partner": { "id": "...", "email": "..." } | null
    }
  }
  ```
  `passwordHash` is stripped from both `user` and `partner`. `partner` is
  `null` if the Space only has one member so far.

**Spaces** (`apps/api/src/spaces`)
- `POST /spaces` — JWT-guarded. Creates `Space` + `SpaceMembership(role:
  'creator')`, re-issues JWT cookie with the new `spaceId`.
- `POST /spaces/pairing-codes` — JWT-guarded, caller must be a member of the
  target space. Deletes any existing unredeemed code for that space, creates
  a new one. Returns `{ code, expiresAt }`. (In practice, under the MVP cap,
  only ever callable by the creator before the space fills — the member who
  redeems immediately hits the 2-member cap, so this endpoint becomes
  unusable for that space afterward. Not specially restricted in code beyond
  "must be a member.")
- `POST /spaces/pairing-codes/redeem` — JWT-guarded. `{ code }` → validates,
  creates `SpaceMembership(role: 'member')`, sets `redeemedAt` /
  `redeemedByUserId`, re-issues JWT cookie with the joined `spaceId`.

## Error taxonomy

| Scenario | Status | Reason |
|---|---|---|
| Code not found | `404` | No such resource |
| Code expired | `410` | Existed, now permanently gone |
| Code already redeemed | `410` | Existed, now permanently consumed |
| Space already has 2 members | `409` | Code is valid; target state violates a constraint |
| Caller already belongs to a Space | `409` | Valid action; caller state prevents it |
| Duplicate email on register | `409` | Resource already exists |

The 410/409 split matters for frontend messaging: 410 → "this code is no
longer valid, ask for a new one"; 409 → state-specific message ("this Space
already has two members" / "you're already part of a Space").

## Self-pairing edge case

A user redeeming their own space's pairing code with a brand-new account is
not specially blocked. In practice this is unreachable for a user who
already has a membership (the "already in a Space" `409` fires first), and
for a genuinely fresh registration it's a harmless, self-inflicted edge
case not worth special-casing for MVP.

## Frontend (minimal, unstyled)

- `/register` → `POST /auth/register` → redirect to `/onboarding`
- `/login` → `POST /auth/login` → redirect to `/dashboard` (has space) or
  `/onboarding` (no space), per `GET /auth/me`
- `/onboarding` → `POST /spaces` → show code → redirect to `/dashboard`
- `/onboarding/pair` → `POST /auth/register` (with `pairingCode`) or
  `POST /spaces/pairing-codes/redeem` → redirect to `/dashboard`

No styling — forms call the API and show the raw `detail` string on error.

## Testing strategy (integration, real Postgres via docker-compose, no mocks)

1. Register → user created, password hashed, cookie set, `spaceId: null`.
2. Register with duplicate email → `409`.
3. Login with correct/incorrect credentials → cookie set / `401`.
4. `GET /auth/me` with no cookie → `401`; with cookie, no space → `{ user, space: null }`.
5. Create space → `SpaceMembership(role: creator)` created, cookie re-issued with new `spaceId`.
6. Create space while already a member → `409`; also directly attempt a duplicate raw insert to confirm the DB unique index rejects it independent of the app check.
7. Generate pairing code → 8-char code returned, `expiresAt` ~24h out.
8. Regenerate code → old row deleted, new code returned, old code now `404`s on redeem.
9. Redeem valid code → membership created (`role: member`), `redeemedAt`/`redeemedByUserId` set, cookie re-issued with joined `spaceId`, `GET /auth/me` for both users shows the other as `partner`.
10. Redeem expired code → `410`.
11. Redeem already-redeemed code → `410`.
12. Redeem code for a space already at 2 members → `409`.
13. Redeem/create-space while caller already has a membership → `409`.
14. Combined register+redeem — invalid code rolls back the whole transaction, no orphaned `User` row.
15. `POST /auth/logout` → cookie cleared/expired, immediate `GET /auth/me` → `401`.
16. **RLS context integration**: after User A and User B are paired in Space X, verify `app.current_space_id` is correctly set to Space X's UUID inside a request made with User A's (or B's) JWT — e.g. a direct `SELECT current_setting('app.current_space_id')` inside the tenant-context transaction. Separately, register User C into a different Space Y and confirm their context resolves to Y, not X. This is the test that proves the JWT → `SET LOCAL` pipeline actually works end-to-end, not just in isolation from the RLS phase.
17. JWT payload verification: decode the cookie after registration and confirm `{ sub: <user-uuid>, spaceId: null }`; decode again after space creation and confirm `{ sub: <same-user-uuid>, spaceId: <new-space-uuid> }`.

## Non-goals / future work

- Refresh token rotation / session revocation lists.
- "Leave a Space" / membership deletion (index upgrade path noted above).
- Password reset / email verification flows.
- Space invitations by email address (code-based only, by design).
- Rate limiting on `/auth/login` and `/spaces/pairing-codes/redeem` —
  flagged as a known security gap and fast-follow, not blocking this phase.
- Polished frontend styling — ugly, functional forms only.
