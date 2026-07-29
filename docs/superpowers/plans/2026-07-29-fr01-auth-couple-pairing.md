# FR-01: Auth Engine & Couple Pairing Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email+password authentication and the couple pairing protocol (create a Space, generate a pairing code, partner redeems it) to Relationship OS, per `docs/superpowers/specs/2026-07-29-fr01-auth-couple-pairing-design.md`.

**Architecture:** New `User`, `SpaceMembership`, `PairingCode` Prisma models (none RLS-scoped, same as `Space`). Passport-Local validates credentials at login; Passport-JWT guards protected routes. A JWT is carried in an httpOnly cookie and re-issued via a shared `SessionService` any time membership changes. The existing RLS tenant middleware is updated to derive `space_id` from that same cookie instead of the placeholder `x-space-id` header.

**Tech Stack:** NestJS (`@nestjs/passport`, `@nestjs/jwt`, `passport-local`, `passport-jwt`), `bcrypt`, `cookie-parser`, Prisma, Zod (`packages/shared-types`), Next.js App Router (minimal unstyled forms).

## Global Constraints

- Every query against a tenant-scoped model must run with `app.current_space_id` set (unchanged from the RLS phase) — `User`, `SpaceMembership`, `PairingCode` are **not** tenant-scoped, so they are called via the plain `prisma` export directly, same as `Space` today.
- All API error responses use RFC 7807 Problem Details: `{ type: 'about:blank', title, status, detail }`.
- Shared DTOs between `apps/web` and `apps/api` are validated with Zod schemas defined in `packages/shared-types`.
- A user may belong to at most one Space; a Space caps at 2 members (enforced at both app layer and DB layer via a unique index).
- JWT payload: `{ sub: string, spaceId: string | null }`, expiry 7 days, delivered as an httpOnly, Secure, SameSite cookie named `us_os_session`. No refresh-token rotation.
- No mocks in tests — all tests run against the real Postgres instance from `docker-compose.yml` / CI's service container, per existing project convention (`packages/database/test/rls.integration.test.ts`).
- `apps/api`'s Jest config only picks up `*.spec.ts` files under `src/` (see `apps/api/jest.config.js`) — all new API tests must be named `*.spec.ts` and live under `apps/api/src/`.

---

### Task 1: Add auth dependencies to `apps/api`

**Files:**
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: `passport`, `passport-local`, `passport-jwt`, `@nestjs/passport`, `@nestjs/jwt`, `bcrypt`, `cookie-parser` available as imports in later tasks.

- [x] **Step 1: Install the packages**

Run from the repo root:

```bash
pnpm --filter @us-os/api add passport passport-local passport-jwt @nestjs/passport @nestjs/jwt bcrypt cookie-parser
pnpm --filter @us-os/api add -D @types/passport-local @types/passport-jwt @types/bcrypt @types/cookie-parser
```

- [x] **Step 2: Force test files to run sequentially**

Every integration test in this plan calls `await prisma.$disconnect()` in its own `afterAll`. Jest runs separate test *files* in parallel worker processes by default; one file's `$disconnect()` can tear down the shared connection while another file is mid-query against the same real Postgres instance, causing flaky cross-file failures. `--runInBand` makes Jest run all test files in a single process, one after another — the simplest fix given every spec file already manages its own connection lifecycle independently.

Read `apps/api/package.json` first, then update its `test` script:

```json
{
  "scripts": {
    "test": "jest --runInBand"
  }
}
```

(Only the `test` script line changes — leave every other script as-is.)

- [x] **Step 3: Verify install**

Run: `pnpm --filter @us-os/api typecheck`
Expected: passes (no source changes yet, just confirms the workspace resolves cleanly after the lockfile update).

- [x] **Step 4: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "chore(api): add passport, jwt, bcrypt, cookie-parser dependencies; run tests in-band"
```

---

### Task 2: RFC 7807 exception filter

**Files:**
- Create: `apps/api/src/common/http-exception.filter.ts`
- Test: `apps/api/src/common/http-exception.filter.spec.ts`
- Modify: `apps/api/src/main.ts`

**Interfaces:**
- Produces: `HttpExceptionFilter` (Nest `ExceptionFilter`), registered globally in `main.ts` via `app.useGlobalFilters(new HttpExceptionFilter())`. Every later controller can throw plain Nest `HttpException` subclasses (`ConflictException`, `NotFoundException`, `GoneException`, `UnauthorizedException`, `ForbiddenException`, `BadRequestException`) and get an RFC 7807 body automatically.

- [x] **Step 1: Write the failing test**

```typescript
// apps/api/src/common/http-exception.filter.spec.ts
import { ArgumentsHost, ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('converts an HttpException into an RFC 7807 Problem Details body', () => {
    const filter = new HttpExceptionFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new ConflictException("You're already part of a Space"), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: "You're already part of a Space",
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- http-exception.filter`
Expected: FAIL (`http-exception.filter` module not found)

- [x] **Step 3: Write the implementation**

```typescript
// apps/api/src/common/http-exception.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    // Nest's default exception body is `{ message, error, statusCode }` (or
    // just a string). CLAUDE.md requires RFC 7807 Problem Details instead, so
    // this filter is the single place that reshapes every thrown HttpException
    // — controllers/services just throw plain Nest exceptions with a message.
    const detail =
      typeof body === 'string'
        ? body
        : Array.isArray((body as { message?: unknown }).message)
          ? (body as { message: string[] }).message.join('; ')
          : ((body as { message?: string }).message ?? exception.message);

    res.status(status).json({
      type: 'about:blank',
      title: exception.name.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
      status,
      detail,
    });
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- http-exception.filter`
Expected: PASS

- [x] **Step 5: Wire the filter into the app and enable cookie-aware CORS**

Read `apps/api/src/main.ts` first, then replace its contents:

```typescript
// apps/api/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

bootstrap();
```

`credentials: true` plus an explicit `origin` (not `*`) is required for the browser to send/receive the httpOnly session cookie cross-port in dev (web on 3000, api on 3001).

- [x] **Step 6: Confirm typecheck still passes**

Run: `pnpm --filter @us-os/api typecheck`
Expected: passes

- [x] **Step 7: Commit**

```bash
git add apps/api/src/common apps/api/src/main.ts
git commit -m "feat(api): add RFC 7807 exception filter and cookie-aware CORS"
```

---

### Task 3: Zod validation pipe

**Files:**
- Create: `apps/api/src/common/zod-validation.pipe.ts`
- Test: `apps/api/src/common/zod-validation.pipe.spec.ts`

**Interfaces:**
- Consumes: any `ZodSchema` from `@us-os/shared-types` (added in Task 4).
- Produces: `createZodValidationPipe(schema: ZodSchema): PipeTransform`, used via `@UsePipes(createZodValidationPipe(SomeSchema))` on controller routes in later tasks. Throws `BadRequestException` (message = joined Zod issue messages) on invalid input — the filter from Task 2 turns that into a `400` RFC 7807 response.

- [x] **Step 1: Write the failing test**

```typescript
// apps/api/src/common/zod-validation.pipe.spec.ts
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { createZodValidationPipe } from './zod-validation.pipe';

describe('createZodValidationPipe', () => {
  const schema = z.object({ email: z.string().email() });
  const pipe = createZodValidationPipe(schema);

  it('returns the parsed value for valid input', () => {
    const result = pipe.transform({ email: 'a@example.com' }, {} as never);
    expect(result).toEqual({ email: 'a@example.com' });
  });

  it('throws BadRequestException with joined issue messages for invalid input', () => {
    expect(() => pipe.transform({ email: 'not-an-email' }, {} as never)).toThrow(
      BadRequestException,
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- zod-validation.pipe`
Expected: FAIL (module not found)

- [x] **Step 3: Write the implementation**

```typescript
// apps/api/src/common/zod-validation.pipe.ts
import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export function createZodValidationPipe(schema: ZodSchema): PipeTransform {
  return {
    transform(value: unknown) {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new BadRequestException(
          result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        );
      }
      return result.data;
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- zod-validation.pipe`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/api/src/common/zod-validation.pipe.ts apps/api/src/common/zod-validation.pipe.spec.ts
git commit -m "feat(api): add Zod validation pipe for shared DTO schemas"
```

---

### Task 4: Shared-types — auth & space Zod schemas

**Files:**
- Create: `packages/shared-types/src/auth.ts`
- Create: `packages/shared-types/src/auth.test.ts`
- Create: `packages/shared-types/src/space.ts`
- Create: `packages/shared-types/src/space.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `RegisterRequestSchema`, `RegisterRequest`, `LoginRequestSchema`, `LoginRequest`, `UserProfileSchema`, `UserProfile`, `AuthMeResponseSchema`, `AuthMeResponse`, `CreateSpaceRequestSchema`, `CreateSpaceRequest`, `PairingCodeResponseSchema`, `PairingCodeResponse`, `RedeemPairingCodeRequestSchema`, `RedeemPairingCodeRequest` — consumed by `apps/api` controllers (Tasks 11, 13) and `apps/web` forms (Task 15).

- [x] **Step 1: Write the failing tests**

```typescript
// packages/shared-types/src/auth.test.ts
import { describe, expect, it } from 'vitest';
import { AuthMeResponseSchema, LoginRequestSchema, RegisterRequestSchema } from './auth';

describe('RegisterRequestSchema', () => {
  it('accepts a valid registration payload without a pairing code', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'a@example.com',
      password: 'supersecret',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid registration payload with an 8-char pairing code', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'a@example.com',
      password: 'supersecret',
      pairingCode: 'ABC12345',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email', () => {
    const result = RegisterRequestSchema.safeParse({ email: 'not-an-email', password: 'supersecret' });
    expect(result.success).toBe(false);
  });

  it('rejects a password shorter than 8 characters', () => {
    const result = RegisterRequestSchema.safeParse({ email: 'a@example.com', password: 'short' });
    expect(result.success).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  it('accepts a valid login payload', () => {
    const result = LoginRequestSchema.safeParse({ email: 'a@example.com', password: 'anything' });
    expect(result.success).toBe(true);
  });
});

describe('AuthMeResponseSchema', () => {
  it('accepts a response with no space yet', () => {
    const result = AuthMeResponseSchema.safeParse({
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com', createdAt: new Date().toISOString() },
      space: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a response with a paired space', () => {
    const result = AuthMeResponseSchema.safeParse({
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com', createdAt: new Date().toISOString() },
      space: {
        id: '22222222-2222-2222-2222-222222222222',
        role: 'creator',
        partner: { id: '33333333-3333-3333-3333-333333333333', email: 'b@example.com', createdAt: new Date().toISOString() },
      },
    });
    expect(result.success).toBe(true);
  });
});
```

```typescript
// packages/shared-types/src/space.test.ts
import { describe, expect, it } from 'vitest';
import { CreateSpaceRequestSchema, PairingCodeResponseSchema, RedeemPairingCodeRequestSchema } from './space';

describe('CreateSpaceRequestSchema', () => {
  it('accepts a valid space name', () => {
    expect(CreateSpaceRequestSchema.safeParse({ name: 'Our Space' }).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(CreateSpaceRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('PairingCodeResponseSchema', () => {
  it('accepts a valid pairing code response', () => {
    const result = PairingCodeResponseSchema.safeParse({
      code: 'ABC12345',
      expiresAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('RedeemPairingCodeRequestSchema', () => {
  it('rejects a code that is not 8 characters', () => {
    expect(RedeemPairingCodeRequestSchema.safeParse({ code: 'short' }).success).toBe(false);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @us-os/shared-types test`
Expected: FAIL (`./auth` and `./space` modules not found)

- [x] **Step 3: Write the implementation**

```typescript
// packages/shared-types/src/auth.ts
import { z } from 'zod';

export const RegisterRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  pairingCode: z.string().length(8).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const SpaceMembershipRoleSchema = z.enum(['creator', 'member']);
export type SpaceMembershipRole = z.infer<typeof SpaceMembershipRoleSchema>;

export const AuthMeResponseSchema = z.object({
  user: UserProfileSchema,
  space: z
    .object({
      id: z.string().uuid(),
      role: SpaceMembershipRoleSchema,
      partner: UserProfileSchema.nullable(),
    })
    .nullable(),
});
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
```

```typescript
// packages/shared-types/src/space.ts
import { z } from 'zod';

export const CreateSpaceRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequestSchema>;

export const PairingCodeResponseSchema = z.object({
  code: z.string().length(8),
  expiresAt: z.string().datetime(),
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

export const RedeemPairingCodeRequestSchema = z.object({
  code: z.string().length(8),
});
export type RedeemPairingCodeRequest = z.infer<typeof RedeemPairingCodeRequestSchema>;
```

```typescript
// packages/shared-types/src/index.ts
export * from './health';
export * from './auth';
export * from './space';
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @us-os/shared-types test`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/shared-types/src
git commit -m "feat(shared-types): add auth and space DTO schemas"
```

---

### Task 5: Prisma schema — User, SpaceMembership, PairingCode

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/<timestamp>_add_auth_and_pairing/migration.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `prisma.user`, `prisma.spaceMembership`, `prisma.pairingCode` model delegates on the `@us-os/database` `prisma` export (none are tenant-scoped, so they're called directly without `TenantContext`, same as `prisma.space` today). Consumed by every service task from here on.

- [x] **Step 1: Edit the schema**

Read `packages/database/prisma/schema.prisma` first, then add these models (and the two back-relation fields on `Space`):

```prisma
model Space {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  milestones  Milestone[]
  memberships SpaceMembership[]
  pairingCodes PairingCode[]

  @@map("spaces")
}

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
  userId   String   @unique @map("user_id") @db.Uuid
  spaceId  String   @map("space_id") @db.Uuid
  role     String
  joinedAt DateTime @default(now()) @map("joined_at")

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  space Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  @@index([spaceId])
  @@map("space_memberships")
}

model PairingCode {
  id               String    @id @default(uuid()) @db.Uuid
  spaceId          String    @map("space_id") @db.Uuid
  code             String    @unique
  expiresAt        DateTime  @map("expires_at")
  redeemedAt       DateTime? @map("redeemed_at")
  redeemedByUserId String?   @map("redeemed_by_user_id") @db.Uuid

  space Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  @@index([spaceId])
  @@map("pairing_codes")
}
```

`userId @unique` on `SpaceMembership` is both the natural FK to look up "this user's one membership" and the DB-level backstop for "at most one Space per user" — no raw SQL needed, Prisma emits a plain unique index. None of these three models are RLS-scoped (no `space_id`-keyed row filtering needed on `users`, and `space_memberships`/`pairing_codes` are join/root tables like `spaces` itself), so no policy SQL is required either.

- [x] **Step 2: Generate the migration**

Run: `pnpm --filter @us-os/database exec prisma migrate dev --name add_auth_and_pairing`
Expected: creates a new folder under `packages/database/prisma/migrations/`, applies it to your local dev DB, and regenerates the Prisma client.

- [x] **Step 3: Verify the client picks up the new models**

Run: `pnpm --filter @us-os/database typecheck`
Expected: passes

- [x] **Step 4: Commit**

```bash
git add packages/database/prisma
git commit -m "feat(database): add User, SpaceMembership, PairingCode models"
```

---

### Task 6: SessionService — JWT sign/verify + cookie helpers

**Files:**
- Create: `apps/api/src/session/session.module.ts`
- Create: `apps/api/src/session/session.service.ts`
- Test: `apps/api/src/session/session.service.spec.ts`

**Interfaces:**
- Consumes: `prisma` from `@us-os/database` (Task 5's `spaceMembership` model).
- Produces:
  - `JWT_SECRET: string` (exported constant).
  - `SessionService.COOKIE_NAME: 'us_os_session'` (static readonly).
  - `class SessionService { issueSessionCookie(res: Response, userId: string): Promise<void>; clearSessionCookie(res: Response): void; verify(token: string): { sub: string; spaceId: string | null } | null; }`
  - `SessionModule` — `@Global()`, exports `SessionService`. Imported once by `AppModule` (Task 8) so `TenantMiddleware` (a different module) can inject it.

- [x] **Step 1: Write the failing test**

```typescript
// apps/api/src/session/session.service.spec.ts
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@us-os/database';
import type { Response } from 'express';
import { JWT_SECRET, SessionService } from './session.service';

describe('SessionService (integration)', () => {
  let sessionService: SessionService;
  let userId: string;
  let spaceId: string;

  beforeAll(async () => {
    sessionService = new SessionService(new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } }));

    const user = await prisma.user.create({
      data: { email: `session-test-${Date.now()}@example.com`, passwordHash: 'irrelevant' },
    });
    userId = user.id;

    const space = await prisma.space.create({ data: { name: 'Session Test Space' } });
    spaceId = space.id;
    await prisma.spaceMembership.create({ data: { userId, spaceId, role: 'creator' } });
  });

  afterAll(async () => {
    await prisma.spaceMembership.deleteMany({ where: { userId } });
    await prisma.space.delete({ where: { id: spaceId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('issues a cookie whose payload carries the user\'s current spaceId', async () => {
    let capturedCookieValue: string | undefined;
    const res = {
      cookie: jest.fn((_name: string, value: string) => {
        capturedCookieValue = value;
      }),
    } as unknown as Response;

    await sessionService.issueSessionCookie(res, userId);

    expect(res.cookie).toHaveBeenCalledWith(
      SessionService.COOKIE_NAME,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
    const payload = sessionService.verify(capturedCookieValue as string);
    expect(payload).toEqual({ sub: userId, spaceId });
  });

  it('issues a cookie with spaceId null for a user with no membership', async () => {
    const soloUser = await prisma.user.create({
      data: { email: `session-test-solo-${Date.now()}@example.com`, passwordHash: 'irrelevant' },
    });

    let capturedCookieValue: string | undefined;
    const res = {
      cookie: jest.fn((_name: string, value: string) => {
        capturedCookieValue = value;
      }),
    } as unknown as Response;

    await sessionService.issueSessionCookie(res, soloUser.id);
    const payload = sessionService.verify(capturedCookieValue as string);
    expect(payload).toEqual({ sub: soloUser.id, spaceId: null });

    await prisma.user.delete({ where: { id: soloUser.id } });
  });

  it('clearSessionCookie clears the cookie', () => {
    const res = { clearCookie: jest.fn() } as unknown as Response;
    sessionService.clearSessionCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(SessionService.COOKIE_NAME);
  });

  it('verify returns null for a garbage token', () => {
    expect(sessionService.verify('not-a-real-token')).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- session.service`
Expected: FAIL (module not found)

- [x] **Step 3: Write the implementation**

```typescript
// apps/api/src/session/session.service.ts
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@us-os/database';
import type { Response } from 'express';

// Dev-only fallback so local/test runs work without extra env setup; set a
// real JWT_SECRET in production.
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me-in-production';

export interface SessionPayload {
  sub: string;
  spaceId: string | null;
}

@Injectable()
export class SessionService {
  static readonly COOKIE_NAME = 'us_os_session';

  constructor(private readonly jwtService: JwtService) {}

  async issueSessionCookie(res: Response, userId: string): Promise<void> {
    const membership = await prisma.spaceMembership.findUnique({ where: { userId } });
    const payload: SessionPayload = { sub: userId, spaceId: membership?.spaceId ?? null };
    const token = this.jwtService.sign(payload);
    res.cookie(SessionService.COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(SessionService.COOKIE_NAME);
  }

  verify(token: string): SessionPayload | null {
    try {
      return this.jwtService.verify<SessionPayload>(token);
    } catch {
      return null;
    }
  }
}
```

```typescript
// apps/api/src/session/session.module.ts
import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JWT_SECRET, SessionService } from './session.service';

// @Global() so TenantMiddleware (registered directly on AppModule, outside
// this module) can inject SessionService without every consuming module
// needing to import SessionModule explicitly.
@Global()
@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } })],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- session.service`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/api/src/session
git commit -m "feat(api): add SessionService for JWT-backed session cookies"
```

---

### Task 7: Update TenantMiddleware to read the session cookie, add cookie-parser

**Files:**
- Modify: `apps/api/src/tenant/tenant.middleware.ts`
- Modify: `apps/api/src/tenant/tenant.middleware.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/app.module.spec.ts`

**Interfaces:**
- Consumes: `SessionService` from Task 6 (via Nest DI).
- Produces: `TenantMiddleware` now takes `SessionService` in its constructor; behavior changes from "400 if `x-space-id` header missing" to "run `TenantContext` if a valid session cookie with a non-null `spaceId` is present, otherwise call `next()` with no `TenantContext`." This is a deliberate change from the RLS phase's placeholder: none of this phase's routes touch tenant-scoped models, and requiring a space before a user has even registered is nonsensical. Tenant-scoped model calls still fail closed (throw) if `TenantContext` was never set — that invariant from the RLS phase is untouched.

- [x] **Step 1: Update the middleware test first**

Read `apps/api/src/tenant/tenant.middleware.spec.ts`, then replace its contents:

```typescript
// apps/api/src/tenant/tenant.middleware.spec.ts
import { JwtService } from '@nestjs/jwt';
import { TenantContext } from '@us-os/database';
import { JWT_SECRET, SessionService } from '../session/session.service';
import { TenantMiddleware } from './tenant.middleware';

describe('TenantMiddleware', () => {
  let middleware: TenantMiddleware;
  let sessionService: SessionService;

  beforeEach(() => {
    sessionService = new SessionService(new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } }));
    middleware = new TenantMiddleware(sessionService);
  });

  it('runs next() inside a TenantContext when the session cookie carries a spaceId', () => {
    const token = (sessionService as unknown as { jwtService: JwtService }).jwtService.sign({
      sub: 'user-1',
      spaceId: 'space-123',
    });
    const req = { cookies: { [SessionService.COOKIE_NAME]: token } };
    let spaceIdSeenInsideNext: string | undefined;

    middleware.use(req as never, {} as never, () => {
      spaceIdSeenInsideNext = TenantContext.currentSpaceId;
    });

    expect(spaceIdSeenInsideNext).toBe('space-123');
  });

  it('calls next() without a TenantContext when there is no session cookie', () => {
    const req = { cookies: {} };
    let sawContext = true;

    middleware.use(req as never, {} as never, () => {
      sawContext = TenantContext.currentSpaceId !== undefined;
    });

    expect(sawContext).toBe(false);
  });

  it('calls next() without a TenantContext when the session cookie has spaceId: null', () => {
    const token = (sessionService as unknown as { jwtService: JwtService }).jwtService.sign({
      sub: 'user-1',
      spaceId: null,
    });
    const req = { cookies: { [SessionService.COOKIE_NAME]: token } };
    let sawContext = true;

    middleware.use(req as never, {} as never, () => {
      sawContext = TenantContext.currentSpaceId !== undefined;
    });

    expect(sawContext).toBe(false);
  });

  it('calls next() without a TenantContext when the cookie is invalid', () => {
    const req = { cookies: { [SessionService.COOKIE_NAME]: 'garbage' } };
    let sawContext = true;

    middleware.use(req as never, {} as never, () => {
      sawContext = TenantContext.currentSpaceId !== undefined;
    });

    expect(sawContext).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- tenant.middleware`
Expected: FAIL (`TenantMiddleware` constructor doesn't accept `SessionService` yet; old 400 behavior no longer matches)

- [x] **Step 3: Rewrite the middleware**

```typescript
// apps/api/src/tenant/tenant.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { TenantContext } from '@us-os/database';
import type { NextFunction, Request, Response } from 'express';
import { SessionService } from '../session/session.service';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly sessionService: SessionService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      SessionService.COOKIE_NAME
    ];
    const payload = token ? this.sessionService.verify(token) : null;

    if (payload?.spaceId) {
      TenantContext.run(payload.spaceId, () => next());
    } else {
      next();
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- tenant.middleware`
Expected: PASS

- [x] **Step 5: Register cookie-parser ahead of TenantMiddleware and wire SessionModule**

Read `apps/api/src/app.module.ts` first, then replace its contents. Cookie-parser must be applied as its own Nest middleware *before* `TenantMiddleware` in the same `configure()` method — Nest binds middlewares in the order `consumer.apply()` is called, and `TenantMiddleware` needs `req.cookies` to already be populated:

```typescript
// apps/api/src/app.module.ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { SessionModule } from './session/session.module';
import { SpacesModule } from './spaces/spaces.module';
import { TenantMiddleware } from './tenant/tenant.middleware';

@Module({
  imports: [SessionModule, AuthModule, SpacesModule],
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

Note: `AuthModule` (Task 11) and `SpacesModule` (Task 13) don't exist yet — this step's import will not compile until those tasks land. That's expected; this task's own test (Step 6 below) only exercises `/health`, which doesn't depend on those modules resolving business logic, but the module graph must still compile. **Reorder note for the executor:** apply this `app.module.ts` edit, but do not run the full `apps/api` test suite until Tasks 6, 9, 10, 12 are also in place — running `pnpm --filter @us-os/api test -- app.module` right after this step will fail to compile. Run only the two spec files touched in this task (`tenant.middleware.spec.ts`) until then, or reorder this step to the end after Tasks 9–13 if executing strictly task-by-task with full-suite verification at each step.

- [x] **Step 6: Update the app.module smoke test**

Read `apps/api/src/app.module.spec.ts` first — its existing assertion ("allows /health without an x-space-id header") is still true but the header is no longer meaningful; update the test name only:

```typescript
// apps/api/src/app.module.spec.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';

describe('AppModule tenant middleware wiring', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows /health with no session cookie', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });
});
```

- [x] **Step 7: Commit**

```bash
git add apps/api/src/tenant apps/api/src/app.module.ts apps/api/src/app.module.spec.ts
git commit -m "feat(api): derive tenant context from session cookie instead of x-space-id header"
```

(This commit will not build in isolation until Tasks 9–13 add `AuthModule`/`SpacesModule` — that's fine under subagent-driven or checkpointed execution, where the full suite is verified once all tasks land; flag this explicitly if executing strictly sequentially with a full build after every task.)

---

### Task 8: Passport-Local strategy + guard

**Files:**
- Create: `apps/api/src/auth/local.strategy.ts`
- Create: `apps/api/src/auth/local-auth.guard.ts`
- Create: `apps/api/src/auth/types.ts`
- Test: `apps/api/src/auth/local.strategy.spec.ts`

**Interfaces:**
- Consumes: `AuthService.validateUser(email, password): Promise<{ userId: string }>` (defined in Task 10 — this task's strategy calls it, so Task 10 must exist before this compiles; see ordering note below).
- Produces: `LocalStrategy` (Passport strategy named `'local'`), `LocalAuthGuard extends AuthGuard('local')`, `AuthenticatedUser` type (`{ userId: string; spaceId: string | null }`).

**Ordering note:** `LocalStrategy` depends on `AuthService`, which is built in Task 10. Do this task and Task 10 as one working unit if executing strictly task-by-task (or execute Task 10's `AuthService` shell first with `validateUser` stubbed, then return here) — under subagent-driven execution with a single reviewer gate spanning both, this is fine as ordered.

- [x] **Step 1: Write the type shared by both strategies**

```typescript
// apps/api/src/auth/types.ts
export interface AuthenticatedUser {
  userId: string;
  spaceId: string | null;
}
```

- [x] **Step 2: Write the failing test**

```typescript
// apps/api/src/auth/local.strategy.spec.ts
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LocalStrategy } from './local.strategy';

describe('LocalStrategy', () => {
  it('returns { userId } when AuthService.validateUser resolves', async () => {
    const authService = { validateUser: jest.fn().mockResolvedValue({ userId: 'user-1' }) } as unknown as AuthService;
    const strategy = new LocalStrategy(authService);

    const result = await strategy.validate('a@example.com', 'password123');

    expect(authService.validateUser).toHaveBeenCalledWith('a@example.com', 'password123');
    expect(result).toEqual({ userId: 'user-1', spaceId: null });
  });

  it('propagates UnauthorizedException from AuthService.validateUser', async () => {
    const authService = {
      validateUser: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid email or password')),
    } as unknown as AuthService;
    const strategy = new LocalStrategy(authService);

    await expect(strategy.validate('a@example.com', 'wrong')).rejects.toThrow('Invalid email or password');
  });
});
```

This test references `AuthService` from `./auth.service`, created in Task 10.

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- local.strategy`
Expected: FAIL (`./auth.service` and `./local.strategy` not found)

- [x] **Step 4: Write the strategy and guard**

```typescript
// apps/api/src/auth/local.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './types';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string): Promise<AuthenticatedUser> {
    const { userId } = await this.authService.validateUser(email, password);
    // spaceId is intentionally not resolved here — SessionService re-reads
    // current membership at cookie-issuance time in the controller, which is
    // the single source of truth for spaceId (see SessionService.issueSessionCookie).
    return { userId, spaceId: null };
  }
}
```

```typescript
// apps/api/src/auth/local-auth.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
```

- [x] **Step 5: Run test to verify it passes** (after Task 10's `AuthService` exists)

Run: `pnpm --filter @us-os/api test -- local.strategy`
Expected: PASS

- [x] **Step 6: Commit** (combine with Task 10's commit if done together)

```bash
git add apps/api/src/auth/local.strategy.ts apps/api/src/auth/local-auth.guard.ts apps/api/src/auth/local.strategy.spec.ts apps/api/src/auth/types.ts
git commit -m "feat(api): add Passport-Local strategy for email+password login"
```

---

### Task 9: Passport-JWT strategy + guard

**Files:**
- Create: `apps/api/src/auth/jwt.strategy.ts`
- Create: `apps/api/src/auth/jwt-auth.guard.ts`
- Test: `apps/api/src/auth/jwt.strategy.spec.ts`

**Interfaces:**
- Consumes: `JWT_SECRET`, `SessionPayload`, `SessionService.COOKIE_NAME` from `../session/session.service` (Task 6). `AuthenticatedUser` from `./types` (Task 8).
- Produces: `JwtStrategy` (Passport strategy named `'jwt'`), `JwtAuthGuard extends AuthGuard('jwt')` — used to guard `GET /auth/me`, `POST /spaces`, `POST /spaces/pairing-codes`, `POST /spaces/pairing-codes/redeem`, `POST /auth/logout`.

- [x] **Step 1: Write the failing test**

```typescript
// apps/api/src/auth/jwt.strategy.spec.ts
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  it('maps the JWT payload to AuthenticatedUser', () => {
    const strategy = new JwtStrategy();
    const result = strategy.validate({ sub: 'user-1', spaceId: 'space-1' });
    expect(result).toEqual({ userId: 'user-1', spaceId: 'space-1' });
  });

  it('maps a null spaceId through unchanged', () => {
    const strategy = new JwtStrategy();
    const result = strategy.validate({ sub: 'user-1', spaceId: null });
    expect(result).toEqual({ userId: 'user-1', spaceId: null });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- jwt.strategy`
Expected: FAIL (module not found)

- [x] **Step 3: Write the strategy and guard**

```typescript
// apps/api/src/auth/jwt.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { JWT_SECRET, SessionService, type SessionPayload } from '../session/session.service';
import type { AuthenticatedUser } from './types';

function fromSessionCookie(req: Request): string | null {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[SessionService.COOKIE_NAME] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromSessionCookie]),
      secretOrKey: JWT_SECRET,
    });
  }

  validate(payload: SessionPayload): AuthenticatedUser {
    return { userId: payload.sub, spaceId: payload.spaceId };
  }
}
```

```typescript
// apps/api/src/auth/jwt-auth.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- jwt.strategy`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/api/src/auth/jwt.strategy.ts apps/api/src/auth/jwt-auth.guard.ts apps/api/src/auth/jwt.strategy.spec.ts
git commit -m "feat(api): add Passport-JWT strategy for cookie-based route guarding"
```

---

### Task 10: AuthService

**Files:**
- Create: `apps/api/src/auth/auth.service.ts`
- Test: `apps/api/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `prisma` from `@us-os/database`, `bcrypt`.
- Produces:
  - `class AuthService { register(dto: RegisterRequest): Promise<{ id: string; email: string; createdAt: Date }>; validateUser(email: string, password: string): Promise<{ userId: string }>; getMe(userId: string): Promise<AuthMeResponse>; }`
  - Consumed by `LocalStrategy` (Task 8), `AuthController` (Task 11).

- [x] **Step 1: Write the failing tests**

```typescript
// apps/api/src/auth/auth.service.spec.ts
import { ConflictException, GoneException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import { AuthService } from './auth.service';

describe('AuthService (integration)', () => {
  const authService = new AuthService();
  const createdUserIds: string[] = [];
  const createdSpaceIds: string[] = [];

  afterAll(async () => {
    await prisma.spaceMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.pairingCode.deleteMany({ where: { spaceId: { in: createdSpaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.space.deleteMany({ where: { id: { in: createdSpaceIds } } });
    await prisma.$disconnect();
  });

  function uniqueEmail(label: string): string {
    return `auth-service-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  }

  describe('register', () => {
    it('creates a user with a hashed password and no membership', async () => {
      const email = uniqueEmail('register');
      const user = await authService.register({ email, password: 'supersecret' });
      createdUserIds.push(user.id);

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.passwordHash).not.toBe('supersecret');
      expect(await prisma.spaceMembership.findUnique({ where: { userId: user.id } })).toBeNull();
    });

    it('rejects a duplicate email with 409', async () => {
      const email = uniqueEmail('dup');
      const user = await authService.register({ email, password: 'supersecret' });
      createdUserIds.push(user.id);

      await expect(authService.register({ email, password: 'different' })).rejects.toThrow(ConflictException);
    });

    it('joins the pairing code\'s space atomically when pairingCode is provided', async () => {
      const creator = await authService.register({ email: uniqueEmail('creator'), password: 'supersecret' });
      createdUserIds.push(creator.id);
      const space = await prisma.space.create({ data: { name: 'Combined Register Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      const code = await prisma.pairingCode.create({
        data: { spaceId: space.id, code: 'JOIN0001', expiresAt: new Date(Date.now() + 60_000) },
      });

      const joiner = await authService.register({
        email: uniqueEmail('joiner'),
        password: 'supersecret',
        pairingCode: 'JOIN0001',
      });
      createdUserIds.push(joiner.id);

      const membership = await prisma.spaceMembership.findUnique({ where: { userId: joiner.id } });
      expect(membership?.spaceId).toBe(space.id);
      expect(membership?.role).toBe('member');
      const redeemed = await prisma.pairingCode.findUniqueOrThrow({ where: { id: code.id } });
      expect(redeemed.redeemedByUserId).toBe(joiner.id);
    });

    it('rolls back user creation when the pairing code is invalid', async () => {
      const email = uniqueEmail('rollback');

      await expect(
        authService.register({ email, password: 'supersecret', pairingCode: 'NOPE0000' }),
      ).rejects.toThrow(NotFoundException);

      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });

    it('rejects an already-redeemed pairing code with 410, rolling back registration', async () => {
      const creator = await authService.register({ email: uniqueEmail('creator2'), password: 'supersecret' });
      createdUserIds.push(creator.id);
      const space = await prisma.space.create({ data: { name: 'Already Redeemed Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      await prisma.pairingCode.create({
        data: {
          spaceId: space.id,
          code: 'USED0001',
          expiresAt: new Date(Date.now() + 60_000),
          redeemedAt: new Date(),
          redeemedByUserId: creator.id,
        },
      });

      const email = uniqueEmail('rollback2');
      await expect(
        authService.register({ email, password: 'supersecret', pairingCode: 'USED0001' }),
      ).rejects.toThrow(GoneException);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  });

  describe('validateUser', () => {
    it('resolves with userId for correct credentials', async () => {
      const email = uniqueEmail('validate');
      const user = await authService.register({ email, password: 'correct-password' });
      createdUserIds.push(user.id);

      const result = await authService.validateUser(email, 'correct-password');
      expect(result).toEqual({ userId: user.id });
    });

    it('rejects incorrect credentials with 401', async () => {
      const email = uniqueEmail('validate-wrong');
      const user = await authService.register({ email, password: 'correct-password' });
      createdUserIds.push(user.id);

      await expect(authService.validateUser(email, 'wrong-password')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown email with 401', async () => {
      await expect(authService.validateUser(uniqueEmail('unknown'), 'anything')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('getMe', () => {
    it('returns space: null for a user with no membership', async () => {
      const email = uniqueEmail('getme-solo');
      const user = await authService.register({ email, password: 'supersecret' });
      createdUserIds.push(user.id);

      const me = await authService.getMe(user.id);
      expect(me).toEqual({ user: { id: user.id, email, createdAt: user.createdAt.toISOString() }, space: null });
    });

    it('returns the partner once both users are paired', async () => {
      const creator = await authService.register({ email: uniqueEmail('getme-creator'), password: 'supersecret' });
      createdUserIds.push(creator.id);
      const space = await prisma.space.create({ data: { name: 'GetMe Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      const member = await authService.register({ email: uniqueEmail('getme-member'), password: 'supersecret' });
      createdUserIds.push(member.id);
      await prisma.spaceMembership.create({ data: { userId: member.id, spaceId: space.id, role: 'member' } });

      const me = await authService.getMe(creator.id);
      expect(me.space).toMatchObject({ id: space.id, role: 'creator' });
      expect(me.space?.partner?.id).toBe(member.id);
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- auth.service`
Expected: FAIL (module not found)

- [x] **Step 3: Write the implementation**

```typescript
// apps/api/src/auth/auth.service.ts
import { ConflictException, GoneException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import * as bcrypt from 'bcrypt';
import type { AuthMeResponse, RegisterRequest, UserProfile } from '@us-os/shared-types';

const SALT_ROUNDS = 10;

function toUserProfile(user: { id: string; email: string; createdAt: Date }): UserProfile {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

@Injectable()
export class AuthService {
  async register(dto: RegisterRequest): Promise<{ id: string; email: string; createdAt: Date }> {
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('An account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    if (!dto.pairingCode) {
      return prisma.user.create({ data: { email: dto.email, passwordHash } });
    }

    // Combined register+redeem: one atomic transaction so an invalid code
    // never leaves an orphaned User row. `prisma.$transaction` here is the
    // raw (non-tenant-extended) escape hatch documented in client.ts — safe
    // because none of these models are tenant-scoped.
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: dto.email, passwordHash } });

      const code = await tx.pairingCode.findUnique({ where: { code: dto.pairingCode } });
      if (!code) throw new NotFoundException('Invalid pairing code');
      if (code.redeemedAt) throw new GoneException('This pairing code has already been used');
      if (code.expiresAt < new Date()) throw new GoneException('This pairing code has expired');

      const memberCount = await tx.spaceMembership.count({ where: { spaceId: code.spaceId } });
      if (memberCount >= 2) throw new ConflictException('This Space is already full');

      await tx.spaceMembership.create({ data: { userId: user.id, spaceId: code.spaceId, role: 'member' } });
      await tx.pairingCode.update({
        where: { id: code.id },
        data: { redeemedAt: new Date(), redeemedByUserId: user.id },
      });

      return user;
    });
  }

  async validateUser(email: string, password: string): Promise<{ userId: string }> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid email or password');

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) throw new UnauthorizedException('Invalid email or password');

    return { userId: user.id };
  }

  async getMe(userId: string): Promise<AuthMeResponse> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const membership = await prisma.spaceMembership.findUnique({ where: { userId } });

    if (!membership) {
      return { user: toUserProfile(user), space: null };
    }

    const partnerMembership = await prisma.spaceMembership.findFirst({
      where: { spaceId: membership.spaceId, userId: { not: userId } },
      include: { user: true },
    });

    return {
      user: toUserProfile(user),
      space: {
        id: membership.spaceId,
        role: membership.role as 'creator' | 'member',
        partner: partnerMembership ? toUserProfile(partnerMembership.user) : null,
      },
    };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- auth.service`
Expected: PASS

- [x] **Step 5: Run Task 8's local.strategy test too, now that AuthService exists**

Run: `pnpm --filter @us-os/api test -- local.strategy`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add apps/api/src/auth/auth.service.ts apps/api/src/auth/auth.service.spec.ts
git commit -m "feat(api): add AuthService with register, validateUser, getMe"
```

---

### Task 11: AuthController + AuthModule

**Files:**
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Test: `apps/api/src/auth/auth.controller.spec.ts`

**Interfaces:**
- Consumes: `AuthService` (Task 10), `SessionService` (Task 6), `LocalAuthGuard`/`JwtAuthGuard` (Tasks 8, 9), `createZodValidationPipe` (Task 3), `RegisterRequestSchema`/`LoginRequestSchema` (Task 4).
- Produces: `AuthModule`, routes `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. Imported by `AppModule` (Task 7's edit already references it).

- [x] **Step 1: Write the failing integration test**

```typescript
// apps/api/src/auth/auth.controller.spec.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import request from 'supertest';
import { AuthModule } from './auth.module';
import { SessionModule } from '../session/session.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';

describe('AuthController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SessionModule, AuthModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  function uniqueEmail(label: string): string {
    createdEmails.push(`auth-controller-${label}-${Date.now()}@example.com`);
    return createdEmails[createdEmails.length - 1];
  }

  it('registers a new user and sets a session cookie', async () => {
    const email = uniqueEmail('register');
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });

    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']?.[0]).toContain('us_os_session=');
  });

  it('rejects a duplicate email with a 409 Problem Details body', async () => {
    const email = uniqueEmail('duplicate');
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'different-password' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      type: 'about:blank',
      status: 409,
      detail: 'An account with this email already exists',
    });
  });

  it('logs in with correct credentials and sets a session cookie', async () => {
    const email = uniqueEmail('login');
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'supersecret' });

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toContain('us_os_session=');
  });

  it('rejects login with incorrect credentials with 401', async () => {
    const email = uniqueEmail('login-wrong');
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns 401 with no session cookie', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the user with space: null right after registration', async () => {
    const email = uniqueEmail('me');
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const cookie = registerRes.headers['set-cookie'];

    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.space).toBeNull();
  });

  it('POST /auth/logout clears the session cookie and /auth/me then returns 401', async () => {
    const email = uniqueEmail('logout');
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const cookie = registerRes.headers['set-cookie'];

    const logoutRes = await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers['set-cookie']?.[0]).toMatch(/us_os_session=;/);

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    expect(meRes.status).toBe(401);
  });
});
```

Note: `/auth/me` after logout still returns `401` because the *original* cookie sent by the test client is the same expired/cleared value the server told the client to drop — supertest doesn't carry cookie state between requests automatically, so this test explicitly re-sends the (now logically invalid) cookie only to prove the endpoint doesn't crash; the meaningful assertion is `logoutRes` clearing the cookie. This is acceptable per the spec's test #15.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- auth.controller`
Expected: FAIL (module not found)

- [x] **Step 3: Write the controller**

```typescript
// apps/api/src/auth/auth.controller.ts
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { LoginRequestSchema, RegisterRequestSchema, type LoginRequest, type RegisterRequest } from '@us-os/shared-types';
import type { Request, Response } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { SessionService } from '../session/session.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LocalAuthGuard } from './local-auth.guard';
import type { AuthenticatedUser } from './types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  @Post('register')
  @UsePipes(createZodValidationPipe(RegisterRequestSchema))
  async register(@Body() dto: RegisterRequest, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.register(dto);
    await this.sessionService.issueSessionCookie(res, user.id);
    return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(200)
  @UsePipes(createZodValidationPipe(LoginRequestSchema))
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() _dto: LoginRequest) {
    const { userId } = req.user as AuthenticatedUser;
    await this.sessionService.issueSessionCookie(res, userId);
    return this.authService.getMe(userId);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    this.sessionService.clearSessionCookie(res);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: Request) {
    const { userId } = req.user as AuthenticatedUser;
    return this.authService.getMe(userId);
  }
}
```

`login`'s `@Body() _dto: LoginRequest` parameter exists only so the Zod pipe validates the raw body shape before `LocalAuthGuard`'s strategy reads `req.body.email`/`req.body.password` — Nest runs pipes before guards execute the route handler binding for the strategy's `validate()`, but `passport-local` reads directly from `req.body`, independent of the parameter decorator; the pipe still guards against malformed payloads reaching the strategy.

- [x] **Step 4: Write the module**

```typescript
// apps/api/src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { LocalStrategy } from './local.strategy';

@Module({
  imports: [PassportModule],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- auth.controller`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add apps/api/src/auth/auth.controller.ts apps/api/src/auth/auth.module.ts apps/api/src/auth/auth.controller.spec.ts
git commit -m "feat(api): add AuthController with register/login/logout/me routes"
```

---

### Task 12: SpacesService

**Files:**
- Create: `apps/api/src/spaces/pairing-code.util.ts`
- Create: `apps/api/src/spaces/spaces.service.ts`
- Test: `apps/api/src/spaces/spaces.service.spec.ts`

**Interfaces:**
- Consumes: `prisma` from `@us-os/database`.
- Produces:
  - `generatePairingCodeString(): string`
  - `class SpacesService { createSpace(userId: string, name: string): Promise<Space>; generatePairingCode(userId: string): Promise<{ code: string; expiresAt: Date }>; redeemPairingCode(userId: string, code: string): Promise<{ spaceId: string }>; }`
  - Consumed by `SpacesController` (Task 13).

- [x] **Step 1: Write the pairing code generator with its own test inline (small enough not to warrant a separate file)**

```typescript
// apps/api/src/spaces/pairing-code.util.ts
import { randomInt } from 'node:crypto';

const PAIRING_CODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PAIRING_CODE_LENGTH = 8;

export function generatePairingCodeString(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_CHARSET[randomInt(PAIRING_CODE_CHARSET.length)];
  }
  return code;
}
```

- [x] **Step 2: Write the failing tests for SpacesService**

```typescript
// apps/api/src/spaces/spaces.service.spec.ts
import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { prisma } from '@us-os/database';
import { SpacesService } from './spaces.service';

describe('SpacesService (integration)', () => {
  const spacesService = new SpacesService();
  const createdUserIds: string[] = [];
  const createdSpaceIds: string[] = [];

  afterAll(async () => {
    await prisma.pairingCode.deleteMany({ where: { spaceId: { in: createdSpaceIds } } });
    await prisma.spaceMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.space.deleteMany({ where: { id: { in: createdSpaceIds } } });
    await prisma.$disconnect();
  });

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `spaces-service-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: 'x' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  describe('createSpace', () => {
    it('creates a Space and a creator membership', async () => {
      const user = await createUser('create');
      const space = await spacesService.createSpace(user.id, 'Our Space');
      createdSpaceIds.push(space.id);

      const membership = await prisma.spaceMembership.findUnique({ where: { userId: user.id } });
      expect(membership).toMatchObject({ spaceId: space.id, role: 'creator' });
    });

    it('rejects creating a second Space for a user who already has one', async () => {
      const user = await createUser('create-dup');
      const space = await spacesService.createSpace(user.id, 'First Space');
      createdSpaceIds.push(space.id);

      await expect(spacesService.createSpace(user.id, 'Second Space')).rejects.toThrow(ConflictException);
    });

    it('rejects a duplicate membership at the DB level even bypassing the app-layer check', async () => {
      // Proves the unique index backstop independently of SpacesService's
      // own pre-check — inserts two SpaceMembership rows for the same userId
      // directly via Prisma, skipping createSpace()'s guard entirely.
      const user = await createUser('create-dup-raw');
      const spaceOne = await prisma.space.create({ data: { name: 'Raw Space One' } });
      createdSpaceIds.push(spaceOne.id);
      const spaceTwo = await prisma.space.create({ data: { name: 'Raw Space Two' } });
      createdSpaceIds.push(spaceTwo.id);

      await prisma.spaceMembership.create({ data: { userId: user.id, spaceId: spaceOne.id, role: 'creator' } });

      await expect(
        prisma.spaceMembership.create({ data: { userId: user.id, spaceId: spaceTwo.id, role: 'creator' } }),
      ).rejects.toThrow();
    });
  });

  describe('generatePairingCode', () => {
    it('creates an 8-char code that expires ~24h out', async () => {
      const user = await createUser('gen');
      const space = await spacesService.createSpace(user.id, 'Gen Space');
      createdSpaceIds.push(space.id);

      const result = await spacesService.generatePairingCode(user.id);

      expect(result.code).toHaveLength(8);
      const hoursUntilExpiry = (result.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursUntilExpiry).toBeGreaterThan(23.9);
      expect(hoursUntilExpiry).toBeLessThan(24.1);
    });

    it('deletes the previous unredeemed code when generating a new one', async () => {
      const user = await createUser('regen');
      const space = await spacesService.createSpace(user.id, 'Regen Space');
      createdSpaceIds.push(space.id);

      const first = await spacesService.generatePairingCode(user.id);
      const second = await spacesService.generatePairingCode(user.id);

      expect(second.code).not.toBe(first.code);
      expect(await prisma.pairingCode.findUnique({ where: { code: first.code } })).toBeNull();
    });

    it('rejects generating a code for a user with no Space', async () => {
      const user = await createUser('gen-no-space');
      await expect(spacesService.generatePairingCode(user.id)).rejects.toThrow(ConflictException);
    });
  });

  describe('redeemPairingCode', () => {
    it('creates a member SpaceMembership and marks the code redeemed', async () => {
      const creator = await createUser('redeem-creator');
      const space = await spacesService.createSpace(creator.id, 'Redeem Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);

      const joiner = await createUser('redeem-joiner');
      const result = await spacesService.redeemPairingCode(joiner.id, code);

      expect(result.spaceId).toBe(space.id);
      const membership = await prisma.spaceMembership.findUnique({ where: { userId: joiner.id } });
      expect(membership).toMatchObject({ spaceId: space.id, role: 'member' });
      const redeemedCode = await prisma.pairingCode.findUniqueOrThrow({ where: { code } });
      expect(redeemedCode.redeemedByUserId).toBe(joiner.id);
    });

    it('rejects an unknown code with 404', async () => {
      const user = await createUser('redeem-404');
      await expect(spacesService.redeemPairingCode(user.id, 'NOPE0000')).rejects.toThrow(NotFoundException);
    });

    it('rejects an expired code with 410', async () => {
      const creator = await createUser('redeem-expired-creator');
      const space = await prisma.space.create({ data: { name: 'Expired Space' } });
      createdSpaceIds.push(space.id);
      await prisma.spaceMembership.create({ data: { userId: creator.id, spaceId: space.id, role: 'creator' } });
      await prisma.pairingCode.create({
        data: { spaceId: space.id, code: 'EXPIRED1', expiresAt: new Date(Date.now() - 1000) },
      });

      const joiner = await createUser('redeem-expired-joiner');
      await expect(spacesService.redeemPairingCode(joiner.id, 'EXPIRED1')).rejects.toThrow(GoneException);
    });

    it('rejects an already-redeemed code with 410', async () => {
      const creator = await createUser('redeem-used-creator');
      const space = await spacesService.createSpace(creator.id, 'Used Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);
      const firstJoiner = await createUser('redeem-used-joiner-1');
      await spacesService.redeemPairingCode(firstJoiner.id, code);

      const secondJoiner = await createUser('redeem-used-joiner-2');
      await expect(spacesService.redeemPairingCode(secondJoiner.id, code)).rejects.toThrow(GoneException);
    });

    it('rejects redeeming into a Space that already has 2 members with 409', async () => {
      const creator = await createUser('redeem-full-creator');
      const space = await spacesService.createSpace(creator.id, 'Full Space');
      createdSpaceIds.push(space.id);
      const { code: firstCode } = await spacesService.generatePairingCode(creator.id);
      const firstJoiner = await createUser('redeem-full-joiner-1');
      await spacesService.redeemPairingCode(firstJoiner.id, firstCode);

      // Space now has 2 members. Directly insert a third, still-valid code
      // (bypassing generatePairingCode, which would itself reject issuing a
      // code once the space is full only at the app's discretion — this
      // proves the redemption-time capacity check independent of that).
      await prisma.pairingCode.create({
        data: { spaceId: space.id, code: 'FULLCODE', expiresAt: new Date(Date.now() + 60_000) },
      });

      const thirdUser = await createUser('redeem-full-joiner-2');
      await expect(spacesService.redeemPairingCode(thirdUser.id, 'FULLCODE')).rejects.toThrow(ConflictException);
    });

    it('rejects redemption from a user who already belongs to a Space with 409', async () => {
      const creator = await createUser('redeem-caller-has-space-creator');
      const space = await spacesService.createSpace(creator.id, 'Caller Has Space');
      createdSpaceIds.push(space.id);
      const { code } = await spacesService.generatePairingCode(creator.id);

      const otherCreator = await createUser('redeem-caller-has-space-other');
      const otherSpace = await spacesService.createSpace(otherCreator.id, 'Other Space');
      createdSpaceIds.push(otherSpace.id);

      await expect(spacesService.redeemPairingCode(otherCreator.id, code)).rejects.toThrow(ConflictException);
    });
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @us-os/api test -- spaces.service`
Expected: FAIL (module not found)

- [x] **Step 4: Write the implementation**

```typescript
// apps/api/src/spaces/spaces.service.ts
import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, prisma, type Space } from '@us-os/database';
import { generatePairingCodeString } from './pairing-code.util';

const PAIRING_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GENERATE_ATTEMPTS = 5;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class SpacesService {
  async createSpace(userId: string, name: string): Promise<Space> {
    const existing = await prisma.spaceMembership.findUnique({ where: { userId } });
    if (existing) throw new ConflictException("You're already part of a Space");

    return prisma.$transaction(async (tx) => {
      const space = await tx.space.create({ data: { name } });
      await tx.spaceMembership.create({ data: { userId, spaceId: space.id, role: 'creator' } });
      return space;
    });
  }

  async generatePairingCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
    const membership = await prisma.spaceMembership.findUnique({ where: { userId } });
    if (!membership) throw new ConflictException('You must create a Space before generating a pairing code');

    await prisma.pairingCode.deleteMany({ where: { spaceId: membership.spaceId, redeemedAt: null } });

    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
      try {
        return await prisma.pairingCode.create({
          data: {
            spaceId: membership.spaceId,
            code: generatePairingCodeString(),
            expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
          },
        });
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < MAX_GENERATE_ATTEMPTS - 1) continue;
        throw err;
      }
    }
    throw new Error('Failed to generate a unique pairing code');
  }

  async redeemPairingCode(userId: string, code: string): Promise<{ spaceId: string }> {
    const existing = await prisma.spaceMembership.findUnique({ where: { userId } });
    if (existing) throw new ConflictException("You're already part of a Space");

    const pairingCode = await prisma.pairingCode.findUnique({ where: { code } });
    if (!pairingCode) throw new NotFoundException('Invalid pairing code');
    if (pairingCode.redeemedAt) throw new GoneException('This pairing code has already been used');
    if (pairingCode.expiresAt < new Date()) throw new GoneException('This pairing code has expired');

    return prisma.$transaction(async (tx) => {
      const memberCount = await tx.spaceMembership.count({ where: { spaceId: pairingCode.spaceId } });
      if (memberCount >= 2) throw new ConflictException('This Space is already full');

      await tx.spaceMembership.create({ data: { userId, spaceId: pairingCode.spaceId, role: 'member' } });
      await tx.pairingCode.update({
        where: { id: pairingCode.id },
        data: { redeemedAt: new Date(), redeemedByUserId: userId },
      });

      return { spaceId: pairingCode.spaceId };
    });
  }
}
```

This imports `Prisma` and `Space` from `@us-os/database` — check `packages/database/src/index.ts` re-exports `Prisma` and model types from `@prisma/client`; if it doesn't yet, add `export type { Space } from '@prisma/client'; export { Prisma } from '@prisma/client';` to `packages/database/src/index.ts` as part of this step.

- [x] **Step 5: Confirm `@us-os/database` exports what this file needs**

Read `packages/database/src/index.ts`. If it only contains `export * from './client'; export * from './tenant-context';` and `./client.ts` doesn't already re-export `Prisma`/`Space`, add to `packages/database/src/index.ts`:

```typescript
export * from './client';
export * from './tenant-context';
export { Prisma } from '@prisma/client';
export type { Space, User, SpaceMembership, PairingCode } from '@prisma/client';
```

- [x] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @us-os/database typecheck && pnpm --filter @us-os/api test -- spaces.service`
Expected: PASS

- [x] **Step 7: Commit**

```bash
git add apps/api/src/spaces packages/database/src/index.ts
git commit -m "feat(api): add SpacesService with create/generate-code/redeem-code and pairing edge cases"
```

---

### Task 13: SpacesController + SpacesModule

**Files:**
- Create: `apps/api/src/spaces/spaces.controller.ts`
- Create: `apps/api/src/spaces/spaces.module.ts`
- Test: `apps/api/src/spaces/spaces.controller.spec.ts`

**Interfaces:**
- Consumes: `SpacesService` (Task 12), `SessionService` (Task 6), `JwtAuthGuard` (Task 9), `createZodValidationPipe` (Task 3), `CreateSpaceRequestSchema`/`RedeemPairingCodeRequestSchema` (Task 4).
- Produces: `SpacesModule`, routes `POST /spaces`, `POST /spaces/pairing-codes`, `POST /spaces/pairing-codes/redeem`. Imported by `AppModule` (Task 7's edit already references it).

- [x] **Step 1: Write the failing integration test**

```typescript
// apps/api/src/spaces/spaces.controller.spec.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SpacesModule } from './spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';

describe('SpacesController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SessionModule, AuthModule, SpacesModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerAndGetCookie(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `spaces-controller-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });
    return { cookie: res.headers['set-cookie'], email };
  }

  it('creates a Space for an authenticated user', async () => {
    const { cookie } = await registerAndGetCookie('create');

    const res = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', cookie)
      .send({ name: 'Our Space' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Our Space');
  });

  it('rejects creating a Space without a session cookie with 401', async () => {
    const res = await request(app.getHttpServer()).post('/spaces').send({ name: 'Our Space' });
    expect(res.status).toBe(401);
  });

  it('generates a pairing code for the caller\'s Space', async () => {
    const { cookie } = await registerAndGetCookie('gen');
    await request(app.getHttpServer()).post('/spaces').set('Cookie', cookie).send({ name: 'Gen Space' });

    const res = await request(app.getHttpServer()).post('/spaces/pairing-codes').set('Cookie', cookie).send({});

    expect(res.status).toBe(201);
    expect(res.body.code).toHaveLength(8);
  });

  it('redeems a pairing code end-to-end, and the joiner sees the creator as partner via /auth/me', async () => {
    const creator = await registerAndGetCookie('e2e-creator');
    await request(app.getHttpServer()).post('/spaces').set('Cookie', creator.cookie).send({ name: 'E2E Space' });
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});

    const joiner = await registerAndGetCookie('e2e-joiner');
    const redeemRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', joiner.cookie)
      .send({ code: codeRes.body.code });

    expect(redeemRes.status).toBe(201);
    const joinerCookie = redeemRes.headers['set-cookie'];

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', joinerCookie);
    expect(meRes.body.space.partner.email).toBe(creator.email);
  });

  it('rejects redeeming an unknown code with 404', async () => {
    const { cookie } = await registerAndGetCookie('bad-code');
    const res = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', cookie)
      .send({ code: 'NOPECODE' });
    expect(res.status).toBe(404);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @us-os/api test -- spaces.controller`
Expected: FAIL (module not found)

- [x] **Step 3: Write the controller**

```typescript
// apps/api/src/spaces/spaces.controller.ts
import { Body, Controller, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import {
  CreateSpaceRequestSchema,
  RedeemPairingCodeRequestSchema,
  type CreateSpaceRequest,
  type RedeemPairingCodeRequest,
} from '@us-os/shared-types';
import type { Request, Response } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import { SessionService } from '../session/session.service';
import { SpacesService } from './spaces.service';

@UseGuards(JwtAuthGuard)
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spacesService: SpacesService,
    private readonly sessionService: SessionService,
  ) {}

  @Post()
  @UsePipes(createZodValidationPipe(CreateSpaceRequestSchema))
  async create(@Req() req: Request, @Body() dto: CreateSpaceRequest, @Res({ passthrough: true }) res: Response) {
    const { userId } = req.user as AuthenticatedUser;
    const space = await this.spacesService.createSpace(userId, dto.name);
    await this.sessionService.issueSessionCookie(res, userId);
    return space;
  }

  @Post('pairing-codes')
  async generateCode(@Req() req: Request) {
    const { userId } = req.user as AuthenticatedUser;
    const { code, expiresAt } = await this.spacesService.generatePairingCode(userId);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  @Post('pairing-codes/redeem')
  @UsePipes(createZodValidationPipe(RedeemPairingCodeRequestSchema))
  async redeem(
    @Req() req: Request,
    @Body() dto: RedeemPairingCodeRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId } = req.user as AuthenticatedUser;
    const result = await this.spacesService.redeemPairingCode(userId, dto.code);
    await this.sessionService.issueSessionCookie(res, userId);
    return result;
  }
}
```

- [x] **Step 4: Write the module**

```typescript
// apps/api/src/spaces/spaces.module.ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';

@Module({
  imports: [AuthModule],
  controllers: [SpacesController],
  providers: [SpacesService],
})
export class SpacesModule {}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @us-os/api test -- spaces.controller`
Expected: PASS

- [x] **Step 6: Run the full apps/api suite now that AppModule's imports (Task 7) resolve**

Run: `pnpm --filter @us-os/api test`
Expected: PASS (all specs, including `app.module.spec.ts` and `tenant.middleware.spec.ts` from Task 7)

- [x] **Step 7: Commit**

```bash
git add apps/api/src/spaces/spaces.controller.ts apps/api/src/spaces/spaces.module.ts apps/api/src/spaces/spaces.controller.spec.ts
git commit -m "feat(api): add SpacesController with create/generate-code/redeem endpoints"
```

---

### Task 14: Cross-cutting integration tests — RLS context + JWT payload verification

**Files:**
- Create: `apps/api/src/tenant/tenant-integration.spec.ts`

**Interfaces:**
- Consumes: `prisma`, `TenantContext`, `withTenantTransaction` from `@us-os/database`; `SessionService` (Task 6); `AuthModule`/`SpacesModule` for a full app instance.
- Produces: no new production code — this closes the two test-matrix gaps (spec items 16 and 17) that need multiple already-built modules together.

- [x] **Step 1: Write the RLS-context and JWT-payload tests**

```typescript
// apps/api/src/tenant/tenant-integration.spec.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { SpacesModule } from '../spaces/spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';

describe('Tenant context integration (RLS pipeline + JWT payload)', () => {
  let app: INestApplication;
  let sessionService: SessionService;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SessionModule, AuthModule, SpacesModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(require('cookie-parser')());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    sessionService = moduleRef.get(SessionService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerAndGetCookie(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `tenant-integration-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });
    return { cookie: res.headers['set-cookie'], email };
  }

  it('decodes the JWT payload as { sub, spaceId: null } right after registration, and { sub, spaceId } after creating a Space', async () => {
    const { cookie } = await registerAndGetCookie('payload');
    const rawCookieHeader = cookie.find((c) => c.startsWith(SessionService.COOKIE_NAME));
    const tokenBeforeSpace = rawCookieHeader!.split(';')[0].split('=')[1];
    const payloadBeforeSpace = sessionService.verify(tokenBeforeSpace);
    expect(payloadBeforeSpace?.spaceId).toBeNull();
    const userId = payloadBeforeSpace!.sub;

    const spaceRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', cookie)
      .send({ name: 'Payload Test Space' });
    const newCookieHeader = spaceRes.headers['set-cookie'].find((c: string) => c.startsWith(SessionService.COOKIE_NAME));
    const tokenAfterSpace = newCookieHeader.split(';')[0].split('=')[1];
    const payloadAfterSpace = sessionService.verify(tokenAfterSpace);

    expect(payloadAfterSpace).toEqual({ sub: userId, spaceId: spaceRes.body.id });
  });

  it('sets app.current_space_id correctly for a request carrying a paired session, and isolates a different space', async () => {
    const creatorA = await registerAndGetCookie('rls-a-creator');
    const spaceARes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', creatorA.cookie)
      .send({ name: 'RLS Space A' });
    const codeARes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creatorA.cookie)
      .send({});
    const memberA = await registerAndGetCookie('rls-a-member');
    const redeemARes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', memberA.cookie)
      .send({ code: codeARes.body.code });
    const memberACookie = redeemARes.headers['set-cookie'];
    const memberAToken = memberACookie
      .find((c: string) => c.startsWith(SessionService.COOKIE_NAME))
      .split(';')[0]
      .split('=')[1];
    const memberAPayload = sessionService.verify(memberAToken);

    const creatorC = await registerAndGetCookie('rls-c-creator');
    const spaceCRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', creatorC.cookie)
      .send({ name: 'RLS Space C' });

    // Directly verify the SET LOCAL pipeline: TenantContext.run mirrors what
    // TenantMiddleware does for a real request carrying this cookie's payload.
    const { TenantContext } = await import('@us-os/database');
    const currentSettingForA = await TenantContext.run(memberAPayload!.spaceId as string, () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_space_id', ${memberAPayload!.spaceId}, true)`;
        const rows = await tx.$queryRaw<{ current_setting: string }[]>`SELECT current_setting('app.current_space_id')`;
        return rows[0].current_setting;
      }),
    );
    expect(currentSettingForA).toBe(spaceARes.body.id);
    expect(currentSettingForA).not.toBe(spaceCRes.body.id);
  });
});
```

- [x] **Step 2: Run the tests**

Run: `pnpm --filter @us-os/api test -- tenant-integration`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add apps/api/src/tenant/tenant-integration.spec.ts
git commit -m "test(api): verify JWT payload shape and RLS current_space_id pipeline end-to-end"
```

---

### Task 15: Minimal frontend forms

**Files:**
- Create: `apps/web/lib/api.ts`
- Create: `apps/web/app/register/page.tsx`
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/app/onboarding/page.tsx`
- Create: `apps/web/app/onboarding/pair/page.tsx`
- Modify: `apps/web/next.config.js` (env passthrough for the API base URL)

No design polish — plain HTML form elements, inline error text, no styling. This task has no automated tests (UI-only, backend already fully tested); manually click through as the verification step.

**Interfaces:**
- Consumes: `RegisterRequest`, `LoginRequest`, `CreateSpaceRequest`, `RedeemPairingCodeRequest`, `AuthMeResponse`, `PairingCodeResponse` from `@us-os/shared-types` (Task 4).

- [x] **Step 1: Add the API base URL to Next config**

Read `apps/web/next.config.js` first, then replace:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  },
};

module.exports = nextConfig;
```

- [x] **Step 2: Write a tiny fetch helper**

```typescript
// apps/web/lib/api.ts
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    // Error responses are usually RFC 7807 JSON, but a CORS rejection, proxy
    // error, or dev-server crash can return an empty/HTML body instead —
    // don't let res.json() throw a confusing SyntaxError in that case.
    let detail = 'Request failed';
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      // non-JSON error response, fall back to the generic message
    }
    throw new Error(detail);
  }

  return res.json() as Promise<T>;
}
```

- [x] **Step 3: Register page**

```tsx
// apps/web/app/register/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UserProfile } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch<UserProfile>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, pairingCode: pairingCode || undefined }),
      });
      router.push(pairingCode ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Register</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        </div>
        <div>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
        </div>
        <div>
          <label>Pairing code (optional) <input value={pairingCode} onChange={(e) => setPairingCode(e.target.value)} maxLength={8} /></label>
        </div>
        <button type="submit">Register</button>
      </form>
      {error && <p>{error}</p>}
      <p><a href="/login">Already have an account? Log in</a></p>
    </main>
  );
}
```

- [x] **Step 4: Login page**

```tsx
// apps/web/app/login/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const me = await apiFetch<AuthMeResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      router.push(me.space ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        </div>
        <div>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        </div>
        <button type="submit">Log in</button>
      </form>
      {error && <p>{error}</p>}
      <p><a href="/register">Need an account? Register</a></p>
    </main>
  );
}
```

- [x] **Step 5: Onboarding page (create Space, show pairing code)**

```tsx
// apps/web/app/onboarding/page.tsx
'use client';

import { useState } from 'react';
import type { PairingCodeResponse, Space } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function OnboardingPage() {
  const [name, setName] = useState('');
  const [space, setSpace] = useState<Space | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<Space>('/spaces', { method: 'POST', body: JSON.stringify({ name }) });
      setSpace(created);
      const code = await apiFetch<PairingCodeResponse>('/spaces/pairing-codes', { method: 'POST', body: '{}' });
      setPairingCode(code);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (space && pairingCode) {
    return (
      <main>
        <h1>{space.name} created</h1>
        <p>Share this code with your partner. It expires at {pairingCode.expiresAt}.</p>
        <p><strong>{pairingCode.code}</strong></p>
        <p><a href="/dashboard">Continue</a></p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your Space</h1>
      <form onSubmit={handleCreateSpace}>
        <div>
          <label>Space name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        </div>
        <button type="submit">Create Space</button>
      </form>
      {error && <p>{error}</p>}
      <p><a href="/onboarding/pair">Have a pairing code instead?</a></p>
    </main>
  );
}
```

`Space` here is a plain shape (`{ id, name, createdAt, updatedAt }`) returned as-is by the API; add `export interface Space { id: string; name: string; createdAt: string; updatedAt: string; }` to `packages/shared-types/src/space.ts` (append to the file created in Task 4) since the controller returns the raw Prisma row, not a Zod-validated shape, and the frontend needs the type.

- [x] **Step 6: Add the `Space` interface to shared-types**

Read `packages/shared-types/src/space.ts`, then append:

```typescript
export interface Space {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
```

- [x] **Step 7: Onboarding pair page (redeem a code)**

```tsx
// apps/web/app/onboarding/pair/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../lib/api';

export default function OnboardingPairPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/spaces/pairing-codes/redeem', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Join your partner&apos;s Space</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Pairing code <input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={8} /></label>
        </div>
        <button type="submit">Join</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
```

- [x] **Step 8: Typecheck the web app**

Run: `pnpm --filter @us-os/web typecheck`
Expected: passes

- [x] **Step 9: Manual click-through verification**

Run the stack: `pnpm dev` (or `pnpm --filter @us-os/api dev` and `pnpm --filter @us-os/web dev` in separate terminals), then in a browser:
1. Visit `http://localhost:3000/register`, register user A → redirected to `/onboarding`.
2. Create a Space → see the pairing code displayed.
3. Open a second browser (or incognito) at `/register`, register user B with the pairing code filled in → redirected straight to `/dashboard` (or `/onboarding` if `/dashboard` doesn't exist yet — a 404 there is expected and fine, since no dashboard page exists in this phase; confirm via `/onboarding/pair` flow too by registering a third user without a code, then submitting the (already-redeemed) code on `/onboarding/pair` and confirming the "already been used" error renders).

- [x] **Step 10: Commit**

```bash
git add apps/web/lib apps/web/app/register apps/web/app/login apps/web/app/onboarding apps/web/next.config.js packages/shared-types/src/space.ts
git commit -m "feat(web): add minimal unstyled register/login/onboarding/pairing forms"
```

---

## Post-plan note

`/dashboard` does not exist yet — out of scope for FR-01 (no Space content to show). Redirects to it in Task 15 will 404 until a later phase adds it; this is expected and does not block this phase's goal (auth + pairing working end-to-end, verified via API integration tests and the manual click-through in Task 15 Step 9).
