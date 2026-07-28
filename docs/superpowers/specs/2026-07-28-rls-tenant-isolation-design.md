# RLS Tenant Isolation Design

Date: 2026-07-28

## Overview

Relationship OS is multi-tenant per `space_id` (a "space" is a couple's shared
workspace). CLAUDE.md requires every query to enforce Row-Level Security keyed
on `space_id`, with data leaks between spaces treated as a critical security
violation. Today, `packages/database` has no domain models and no RLS
mechanism at all — this is a from-scratch design for the enforcement
mechanism, proven end-to-end against one concrete example table (`Milestone`).

Passport-based auth is not yet implemented in `apps/api`. This design
deliberately decouples tenant-context plumbing from auth so it can be built
and tested now, with a single swap-in point for real auth later.

## Safety invariant

**Every query against a tenant-scoped model runs on a connection where
`app.current_space_id` has been set to the caller's `spaceId`, within the
same transaction as the query.**

Three cooperating pieces maintain this invariant:

1. **NestJS middleware** — populates `TenantContext` from the request, per
   request.
2. **Prisma Client Extension** — calls `set_config('app.current_space_id',
   ...)` and the model operation inside the same transaction, on every call
   through the ORM.
3. **RLS policy** — filters (`USING`) and validates (`WITH CHECK`) every row
   against `current_setting('app.current_space_id', ...)`.

If any piece is bypassed or misconfigured, the system is designed to fail
closed: a missing `TenantContext` throws before any SQL is issued, and a
missing/empty session variable makes the RLS policy match zero rows rather
than leaking or erroring. Anyone changing the session variable name
(`'app.current_space_id'`) must update it in both the extension and the
policy SQL — nothing enforces that the two stay in sync besides this note.

**The one way to break the invariant silently: raw queries.** Calling
`prisma.$queryRaw`/`$executeRaw` directly against a tenant-scoped table
bypasses the extension's `$allOperations` hook entirely, so no `set_config`
runs on that connection. Because Prisma's pool reuses connections across
requests, a raw query could then either fail closed (no `app.current_space_id`
ever set on that connection) or, worse, inherit a stale value left by a
previous request's `SET LOCAL`/`set_config` if a prior transaction's
in-transaction setting somehow leaked past commit — in practice `set_config`
with `is_local = true` is cleared at transaction end, so the realistic
failure mode is "no rows" rather than cross-tenant leakage, but raw queries
against tenant-scoped tables should be avoided; route through the Prisma
Client model methods instead.

## Schema

```prisma
model Space {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  milestones Milestone[]
  @@map("spaces")
}

model Milestone {
  id         String   @id @default(uuid()) @db.Uuid
  spaceId    String   @map("space_id") @db.Uuid
  title      String
  occurredAt DateTime @map("occurred_at")
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  space Space @relation(fields: [spaceId], references: [id])
  @@map("milestones")
  @@index([spaceId])
}
```

`@db.Uuid` is required on every id/foreign-key column. Without it, Prisma maps
`String` fields to Postgres `text`, and the RLS policy's `::uuid` cast against
`current_setting(...)` would fail with a type mismatch at query time.

`Milestone` is the example tenant-scoped table proving the pattern
end-to-end. Future tenant tables (Decision, Goal, Media, etc.) follow the
identical `space_id @db.Uuid` + policy shape. `Space` itself is the tenant
root — it has no `space_id` column and is not RLS-scoped.

## RLS policy (raw SQL, hand-added to the migration after `prisma migrate dev`)

```sql
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON milestones
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);
```

- `current_setting(..., true)` (the `true` = "missing_ok") returns `NULL`
  instead of raising when the session variable was never set, so an
  unauthenticated/misconfigured connection fails closed (matches zero rows)
  rather than erroring.
- `nullif(..., '')` guards the case where the setting is explicitly set to an
  empty string (e.g. a middleware bug) — without it, `''::uuid` throws a cast
  error instead of failing closed to "no rows match."
- `FORCE ROW LEVEL SECURITY` is required because the Postgres user that owns
  the tables (via migrations) is the same `us_os` user the app connects as in
  the current docker-compose setup, and RLS is bypassed for table owners by
  default. `FORCE` closes that bypass. (A separate least-privilege runtime
  role is a reasonable future hardening step but is out of scope here — it
  would require new env vars and docker-compose/CI changes not otherwise
  needed yet.)
- `WITH CHECK` (in addition to `USING`) is required so writes are validated
  too: `USING` alone only protects reads/updates/deletes from seeing
  cross-tenant rows, but a bare `INSERT`/`UPDATE` could otherwise still write
  a row with a foreign `space_id`. `WITH CHECK` rejects that at the database
  level.

## Tenant context propagation

`packages/database/src/tenant-context.ts` — an `AsyncLocalStorage`-based
store, not NestJS request-scoped DI. Request-scoped providers bubble scope up
through the whole dependency graph and add per-request instantiation
overhead, working against the P95 < 150ms target; `AsyncLocalStorage` carries
context across async boundaries with no DI graph impact.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

type Store = { spaceId: string; tx?: Prisma.TransactionClient };
const als = new AsyncLocalStorage<Store>();

export const TenantContext = {
  run<T>(spaceId: string, fn: () => T): T {
    return als.run({ spaceId }, fn);
  },
  get spaceId(): string {
    const spaceId = this.currentSpaceId;
    if (!spaceId) throw new Error('TenantContext: no space set for this request');
    return spaceId;
  },
  get currentSpaceId(): string | undefined {
    return als.getStore()?.spaceId;
  },
  get activeTx(): Prisma.TransactionClient | undefined {
    return als.getStore()?.tx;
  },
  runWithTx<T>(tx: Prisma.TransactionClient, fn: () => T): T {
    const store = als.getStore();
    if (!store) throw new Error('TenantContext: runWithTx requires an active space context');
    return als.run({ ...store, tx }, fn);
  },
};
```

`currentSpaceId` (optional, returns `undefined`) exists alongside the strict
`spaceId` getter so system-level paths — seed scripts, background workers,
admin tooling — can check for tenant context without throwing, while
request-path code that requires a space uses the strict getter.

## Prisma Client Extension

`packages/database/src/client.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { TenantContext } from './tenant-context';

const basePrisma = new PrismaClient();

const TENANT_SCOPED_MODELS = new Set(['Milestone']);

export const prisma = basePrisma.$extends({
  query: {
    $allOperations: async ({ model, operation, args, query }) => {
      if (!model || !TENANT_SCOPED_MODELS.has(model)) {
        return query(args);
      }
      const camelModel = model.charAt(0).toLowerCase() + model.slice(1);

      const activeTx = TenantContext.activeTx;
      if (activeTx) {
        // Already inside withTenantTransaction — set_config ran once on this
        // connection already; reuse it instead of opening a nested transaction.
        return (activeTx as unknown as PrismaClient)[camelModel as 'milestone'][operation](args);
      }

      const spaceId = TenantContext.currentSpaceId;
      if (!spaceId) throw new Error(`TenantContext: no space set for ${model}.${operation}`);

      return basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_space_id', ${spaceId}, true)`;
        return (tx as unknown as PrismaClient)[camelModel as 'milestone'][operation](args);
      });
    },
  },
});

export async function withTenantTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const spaceId = TenantContext.spaceId;
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_space_id', ${spaceId}, true)`;
    return TenantContext.runWithTx(tx, () => fn(tx));
  });
}
```

Design points:

- **Scoped to tenant models only.** `$allOperations` skips the transaction
  wrapper for models not in `TENANT_SCOPED_MODELS` (currently just `Space`),
  so space creation/lookup works without requiring a `TenantContext` to
  already exist.
- **Operation dispatch uses `tx`, not `query(args)`.** Prisma's extension
  `query` continuation re-enters the *original* client chain (`basePrisma`),
  not the transaction client — calling it inside the `$transaction` callback
  would not guarantee the model operation lands on the same connection the
  `set_config` ran on. Calling `(tx as ...)[camelModel][operation](args)`
  directly forces the real operation through `tx`, which Prisma guarantees
  stays on one physical connection for the transaction's lifetime.
- **Model name casing.** The `model` value the extension receives is
  PascalCase (`'Milestone'`), but Prisma client properties are camelCase
  (`tx.milestone`). The extension lowercases the first character before
  dynamic property access; skipping this makes every tenant-scoped query
  silently resolve to `undefined` and throw.
- **`set_config(..., true)` over string-interpolated `SET LOCAL`.** The third
  argument `true` is "is_local," Postgres's parameterized equivalent of `SET
  LOCAL` — scoped to the transaction and safe from injection since `spaceId`
  is passed as a bound parameter, not interpolated into SQL text.
- **Nested-transaction handling.** If the extension always opened its own
  `basePrisma.$transaction(...)`, calling a tenant-scoped model from inside an
  already-open explicit transaction (e.g. a future "create milestone + write
  audit log" atomic service method) would silently start a second, unrelated
  transaction on a possibly different pooled connection — breaking atomicity
  and risking pool exhaustion under a small pool size. `withTenantTransaction`
  is the required entry point for any future multi-model atomic operation: it
  opens one transaction, runs `set_config` once, and stores the `tx` handle
  via `TenantContext.runWithTx`. Every tenant-scoped call inside that callback
  then sees `TenantContext.activeTx` is set and reuses it directly instead of
  nesting a nested transaction.

## NestJS middleware (auth placeholder)

`apps/api/src/tenant/tenant.middleware.ts`:

```ts
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const spaceId = req.header('x-space-id');
    if (!spaceId) {
      return res.status(400).json({
        type: 'about:blank',
        title: 'Missing tenant context',
        status: 400,
        detail: 'x-space-id header is required',
      });
    }
    TenantContext.run(spaceId, () => next());
  }
}
```

This reads `spaceId` from a request header as a placeholder. Once
Passport-based auth is implemented, this becomes the single swap point:
replace the header read with the validated `spaceId` claim from
`req.user`/JWT. Nothing downstream (the extension, the RLS policy, service
code) needs to change.

## Error handling

- Missing tenant header → `400` RFC 7807 Problem Details response, request
  never reaches Prisma.
- Missing `TenantContext` at query time (a code path that skipped the
  middleware, e.g. a background job) → the extension throws a plain `Error`
  before issuing any SQL, so no query is ever attempted without a space.
- Cross-tenant write attempt → rejected at the database level by the
  `WITH CHECK` clause (Postgres raises a row-security violation), not just
  hidden by the app layer.

## Testing strategy (integration, real Postgres via docker-compose — no mocks)

1. **Isolation**: create Space A and Space B, insert a `Milestone` under each
   via `TenantContext.run`, then query milestones under A's context and
   assert B's row is absent (and vice versa).
2. **Fail-closed, no context**: query a tenant-scoped model with no
   `TenantContext` set and assert it throws before any SQL is issued.
3. **Cross-tenant write rejection**: under Space A's context, attempt to
   insert a `Milestone` with `spaceId` set to Space B's id, and assert the
   `WITH CHECK` policy rejects it at the database level.
4. **Empty-string guard**: directly `set_config('app.current_space_id', '',
   true)` and confirm a query returns zero rows rather than throwing a cast
   error.
5. **Multi-model atomicity**: inside `withTenantTransaction`, perform two
   writes where the second throws; assert the first is rolled back — proving
   real atomicity rather than two independent auto-wrapped transactions.

## Non-goals / future work

- A separate least-privilege Postgres role for runtime queries (vs. the
  current single `us_os` owner + `FORCE ROW LEVEL SECURITY`) — worth
  revisiting before production but not needed for this phase.
- Real Passport auth populating `TenantContext` from a JWT claim — tracked
  separately; the middleware's header read is the documented placeholder.
- Space membership/authorization (who may act as which space) — no `User` or
  membership model exists yet; this design only covers tenant *data*
  isolation once a space is already known to be valid for the caller.
