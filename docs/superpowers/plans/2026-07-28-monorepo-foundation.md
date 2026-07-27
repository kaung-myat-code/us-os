# Monorepo Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Relationship OS (`us-os`) Turborepo monorepo skeleton — pnpm workspaces, `apps/web`, `apps/api`, `packages/database`, `packages/shared-types`, `packages/config`, `turbo.json`, and a `docker-compose.yml` for local Postgres 16 + Redis — with each piece buildable, lintable, and testable end to end.

**Architecture:** A pnpm-workspace monorepo orchestrated by Turborepo. `packages/config` holds the shared TypeScript/Prettier base config consumed by every other workspace. `packages/shared-types` exposes Zod schemas + inferred types (starting with a `HealthStatus` schema) consumed by both apps. `packages/database` wraps a Prisma client pointed at the Postgres 16 container defined in `docker-compose.yml`. `apps/api` is a NestJS service exposing a `GET /health` endpoint that returns a `HealthStatus`, proving the shared-types wiring works. `apps/web` is a Next.js 14 App Router PWA shell that imports the same `HealthStatus` type, proving cross-app type sharing works. No feature/domain logic (auth, encryption, RLS policies, timeline/goals models) is in scope — those land in later phases per `CLAUDE.md`.

**Tech Stack:** pnpm 9, Turborepo 2, TypeScript 5.6, Next.js 14 (App Router, Tailwind CSS), NestJS 10, Prisma 5 (PostgreSQL 16), Redis 7, Zod 3, Vitest 2 (packages), Jest 29 (NestJS), Docker Compose.

## Global Constraints

- Node.js >=20.0.0, pnpm 9.15.9 (pin via root `packageManager` field).
- All workspace packages are scoped `@us-os/*`; app package names are `@us-os/web` and `@us-os/api`.
- Cross-package imports must use the `workspace:*` protocol — never relative `../../` imports across package boundaries.
- Postgres version is fixed at 16 (per `CLAUDE.md` infra requirements); Redis is used for BullMQ queues/caching in later phases but only needs to run locally for now.
- Shared DTOs/types must live in `packages/shared-types` and be defined with Zod (per `CLAUDE.md` API & Validation Standard) — this plan establishes the pattern with a `HealthStatus` schema.
- No RLS policies, auth, or encryption logic in this plan — `packages/database`'s Prisma schema intentionally has zero models; it only wires the datasource/generator so `prisma generate`/`migrate` work end to end.
- Every task must leave `pnpm install` runnable from the repo root with no errors.
- Dependency versions in this plan are deliberately pinned to specific majors that are known to work with the hand-written config/scaffold syntax below: TypeScript 5.6.x (not 7.x), Next.js 14.x (per `CLAUDE.md`'s "Next.js 14+" requirement — not 16.x), NestJS 10.x (not 11.x), Prisma 5.x schema format (not 7.x's config format), ESLint 8.x `.eslintrc` format (not 10.x's flat-config-only format), Turborepo 2.3.x. All listed versions exist on the npm registry and are installable even though newer majors now exist — upgrading to those majors is a separate, deliberate task outside this plan's scope, since each is a breaking change to config formats used here.

---

## File Structure

```
us-os/
├── docker-compose.yml
├── turbo.json
├── package.json
├── pnpm-workspace.yaml
├── .npmrc
├── .gitignore
├── .env.example
├── apps/
│   ├── web/                      # Next.js 14 App Router shell
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.js
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.js
│   │   ├── .eslintrc.json
│   │   ├── next-env.d.ts
│   │   └── app/
│   │       ├── layout.tsx
│   │       ├── page.tsx
│   │       └── globals.css
│   └── api/                      # NestJS REST API
│       ├── package.json
│       ├── tsconfig.json
│       ├── nest-cli.json
│       ├── jest.config.js
│       ├── .eslintrc.json
│       └── src/
│           ├── main.ts
│           ├── app.module.ts
│           └── health/
│               ├── health.controller.ts
│               └── health.controller.spec.ts
└── packages/
    ├── config/                   # shared TS/Prettier/ESLint base config
    │   ├── package.json
    │   ├── tsconfig.base.json
    │   ├── prettier.config.cjs
    │   └── eslint-preset.cjs
    ├── shared-types/             # Zod schemas + inferred TS types
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vitest.config.ts
    │   ├── .eslintrc.cjs
    │   └── src/
    │       ├── health.ts
    │       ├── health.test.ts
    │       └── index.ts
    └── database/                 # Prisma schema + client wrapper
        ├── package.json
        ├── tsconfig.json
        ├── .env.example
        ├── prisma/
        │   ├── schema.prisma
        │   └── seed.ts
        └── src/
            ├── client.ts
            └── index.ts
```

Files that change together stay together: each workspace package is fully self-contained (its own `package.json`/`tsconfig.json`), configuration is centralized in `packages/config`, and infra (`docker-compose.yml`, `.env.example`) lives at the root since it's shared across all workspaces.

---

### Task 1: Root workspace scaffolding

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.npmrc`
- Create: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: root scripts `dev`, `build`, `lint`, `test`, `typecheck`, `db:migrate`, `db:generate`, `db:studio`, `db:seed` — all later tasks' packages must expose the matching per-package script names (`dev`, `build`, `lint`, `test`, `typecheck`) for Turborepo to fan them out.
- Produces: pnpm workspace globs `apps/*` and `packages/*` — every subsequent task's package must live under one of these two directories to be picked up.

- [ ] **Step 1: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Write the root `package.json`**

```json
{
  "name": "us-os",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "db:migrate": "pnpm --filter @us-os/database db:migrate",
    "db:generate": "pnpm --filter @us-os/database db:generate",
    "db:studio": "pnpm --filter @us-os/database db:studio",
    "db:seed": "pnpm --filter @us-os/database db:seed"
  },
  "devDependencies": {
    "prettier": "^3.3.3",
    "turbo": "^2.3.0",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 3: Write `.npmrc`**

```
auto-install-peers=true
strict-peer-dependencies=false
```

`auto-install-peers=true` avoids manual peer-dependency installs across the Next.js/NestJS/Prisma toolchain. `strict-peer-dependencies` is left `false` (not `true`) deliberately: Next.js and NestJS both carry peer ranges that lag their own dependents' actual releases, so `true` would turn routine peer-version drift into hard install failures — the workspace already pins exact compatible majors (see Global Constraints), so strict enforcement adds risk without real benefit here.

- [ ] **Step 4: Write `.gitignore`**

```
node_modules
.turbo
dist
.next
coverage
*.log
.env
.env.local
.DS_Store
```

- [ ] **Step 5: Write `.env.example`**

```
DATABASE_URL="postgresql://us_os:us_os_dev_password@localhost:5432/us_os_dev?schema=public"
REDIS_URL="redis://localhost:6379"
PORT=3001
```

- [ ] **Step 6: Verify pnpm recognizes the workspace**

Run: `pnpm -v && pnpm ls --depth -1`
Expected: prints `9.15.9` (or newer 9.x) and reports no workspace packages found yet (none created), without erroring on workspace config.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml .npmrc .gitignore .env.example
git commit -m "chore: scaffold root pnpm workspace"
```

---

### Task 2: `packages/config` — shared TypeScript/Prettier/ESLint base

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.base.json`
- Create: `packages/config/prettier.config.cjs`
- Create: `packages/config/eslint-preset.cjs`

**Interfaces:**
- Produces: `packages/config/tsconfig.base.json` — every other workspace's `tsconfig.json` extends this via a relative path (`../../packages/config/tsconfig.base.json`).
- Produces: `packages/config/eslint-preset.cjs` — a CommonJS ESLint config object consumed by `packages/shared-types` and `packages/database` (plain TS packages; `apps/web` and `apps/api` use their own framework-specific ESLint configs instead, per Task 7/8).
- This package intentionally has no `lint`/`test`/`typecheck` scripts of its own: it contains only `.json`/`.cjs` config files with no TypeScript source to check and nothing to unit test. Turborepo skips packages that lack a given task's script, so `pnpm lint`/`pnpm typecheck`/`pnpm test` simply omit `@us-os/config` — this is expected, not a gap.

- [ ] **Step 1: Write `packages/config/package.json`**

```json
{
  "name": "@us-os/config",
  "version": "0.0.0",
  "private": true,
  "files": [
    "tsconfig.base.json",
    "prettier.config.cjs",
    "eslint-preset.cjs"
  ]
}
```

- [ ] **Step 2: Write `packages/config/tsconfig.base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "declaration": false
  }
}
```

- [ ] **Step 3: Write `packages/config/prettier.config.cjs`**

```js
module.exports = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
};
```

- [ ] **Step 4: Write `packages/config/eslint-preset.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules'],
};
```

- [ ] **Step 5: Add shared ESLint/TypeScript-ESLint devDependencies to the root `package.json`**

Edit `package.json`'s `devDependencies` (from Task 1) to:

```json
{
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^8.14.0",
    "@typescript-eslint/parser": "^8.14.0",
    "eslint": "^8.57.1",
    "prettier": "^3.3.3",
    "turbo": "^2.3.0",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 6: Verify the JSON/JS files parse**

Run: `node -e "require('./packages/config/prettier.config.cjs'); require('./packages/config/eslint-preset.cjs'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 7: Commit**

```bash
git add packages/config package.json
git commit -m "chore: add shared config package"
```

---

### Task 3: `packages/shared-types` — Zod schemas + inferred types

**Files:**
- Create: `packages/shared-types/package.json`
- Create: `packages/shared-types/tsconfig.json`
- Create: `packages/shared-types/vitest.config.ts`
- Create: `packages/shared-types/src/health.ts`
- Test: `packages/shared-types/src/health.test.ts`
- Create: `packages/shared-types/src/index.ts`
- Create: `packages/shared-types/.eslintrc.cjs`

**Interfaces:**
- Consumes: `packages/config/tsconfig.base.json` and `packages/config/eslint-preset.cjs` (Task 2).
- Produces: `HealthStatusSchema` (Zod schema) and `HealthStatus` (inferred type), exported from `@us-os/shared-types` — consumed by `apps/api`'s `HealthController` (Task 7) and `apps/web`'s home page (Task 8).

- [ ] **Step 1: Write `packages/shared-types/package.json`**

```json
{
  "name": "@us-os/shared-types",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint \"src/**/*.ts\"",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^8.14.0",
    "@typescript-eslint/parser": "^8.14.0",
    "eslint": "^8.57.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

`eslint` and `@typescript-eslint/*` are declared here directly (not left to hoist from the root) so `pnpm --filter @us-os/shared-types lint` resolves them deterministically regardless of pnpm's hoisting behavior.

- [ ] **Step 2: Write `packages/shared-types/.eslintrc.cjs`**

```js
module.exports = {
  ...require('../config/eslint-preset.cjs'),
};
```

- [ ] **Step 3: Write `packages/shared-types/tsconfig.json`**

```json
{
  "extends": "../config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `packages/shared-types/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Write the failing test — `packages/shared-types/src/health.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { HealthStatusSchema } from './health';

describe('HealthStatusSchema', () => {
  it('accepts a valid health status payload', () => {
    const result = HealthStatusSchema.safeParse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });

    expect(result.success).toBe(true);
  });

  it('rejects a payload with an invalid status value', () => {
    const result = HealthStatusSchema.safeParse({
      status: 'unknown',
      timestamp: new Date().toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing the timestamp', () => {
    const result = HealthStatusSchema.safeParse({ status: 'ok' });

    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 6: Install dependencies so vitest is resolvable, then run the test to verify it fails**

Run: `pnpm install && pnpm --filter @us-os/shared-types test`
Expected: FAIL — `Cannot find module './health'` (or similar), since `src/health.ts` does not exist yet.

- [ ] **Step 7: Write the minimal implementation — `packages/shared-types/src/health.ts`**

```ts
import { z } from 'zod';

export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  timestamp: z.string().datetime(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
```

- [ ] **Step 8: Write the barrel file — `packages/shared-types/src/index.ts`**

```ts
export * from './health';
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @us-os/shared-types test`
Expected: PASS — all 3 tests green.

- [ ] **Step 10: Verify typecheck and lint pass**

Run: `pnpm --filter @us-os/shared-types typecheck && pnpm --filter @us-os/shared-types lint`
Expected: both exit 0, no output.

- [ ] **Step 11: Commit**

```bash
git add packages/shared-types
git commit -m "feat: add shared-types package with HealthStatus schema"
```

---

### Task 4: `packages/database` — Prisma schema + client wrapper

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/.env.example`
- Create: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/seed.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `packages/config/tsconfig.base.json` (Task 2).
- Produces: `prisma` (a `PrismaClient` singleton), exported from `@us-os/database` — later feature phases import this to run queries; no consumer exists yet in this plan.

- [ ] **Step 1: Write `packages/database/package.json`**

```json
{
  "name": "@us-os/database",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:studio": "prisma studio",
    "db:seed": "tsx prisma/seed.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0"
  },
  "devDependencies": {
    "prisma": "^5.22.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Write `packages/database/tsconfig.json`**

```json
{
  "extends": "../config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/database/.env.example`**

```
DATABASE_URL="postgresql://us_os:us_os_dev_password@localhost:5432/us_os_dev?schema=public"
```

- [ ] **Step 4: Write `packages/database/prisma/schema.prisma`**

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// Domain models (Space, Milestone, Decision, Goal, Media, etc.) are added
// per-feature in later phases. This file only wires the datasource/generator
// so `prisma generate`/`migrate` work end to end for this foundation phase.
```

- [ ] **Step 5: Write `packages/database/prisma/seed.ts`**

```ts
import { prisma } from '../src/client';

async function main(): Promise<void> {
  console.log('No domain models exist yet, so there is nothing to seed in this foundation phase.');
  console.log('Feature phases that add Prisma models should extend this function with real seed data.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 6: Write `packages/database/src/client.ts`**

```ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 7: Write `packages/database/src/index.ts`**

```ts
export * from './client';
```

- [ ] **Step 8: Install dependencies and generate the Prisma client**

Run: `pnpm install && pnpm --filter @us-os/database db:generate`
Expected: `Generated Prisma Client` success message; no models are listed (schema has none yet), which is expected.

- [ ] **Step 9: Verify typecheck passes**

Run: `pnpm --filter @us-os/database typecheck`
Expected: exits 0, no output.

- [ ] **Step 10: Commit**

```bash
git add packages/database
git commit -m "feat: add database package with Prisma client wrapper"
```

Connecting to Postgres and running `db:migrate` is verified in Task 5, once the container exists.

---

### Task 5: `docker-compose.yml` — Postgres 16 + Redis, and first migration

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: `DATABASE_URL`/`REDIS_URL` values from `.env.example` (Task 1) — the compose file's credentials must match those exactly.
- Produces: a running `us-os-postgres` container on `localhost:5432` and `us-os-redis` container on `localhost:6379`, which `packages/database`'s `db:migrate` (Task 4) and later `apps/api` (Task 7) connect to.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: us-os-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: us_os
      POSTGRES_PASSWORD: us_os_dev_password
      POSTGRES_DB: us_os_dev
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U us_os -d us_os_dev"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: us-os-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

- [ ] **Step 2: Bring the stack up and block until both containers report healthy**

Run: `docker compose up -d --wait`
Expected: command blocks (rather than a fixed `sleep`) until both healthchecks pass, then exits 0. The healthchecks retry every 5s up to 5 times, so a fixed `sleep 5` can't be trusted to outlast a slow container start — `--wait` waits for the actual healthy state instead, however long that takes, and fails loudly if a container never becomes healthy.

- [ ] **Step 3: Copy env file and run the first (empty) migration against the real database**

Run: `cp .env.example packages/database/.env && pnpm --filter @us-os/database db:migrate -- --name init`
Expected: Prisma reports "Your database is now in sync with your schema" and creates `packages/database/prisma/migrations/<timestamp>_init/migration.sql` (an empty migration, since there are no models yet).

- [ ] **Step 4: Verify Redis is reachable**

Run: `docker exec us-os-redis redis-cli ping`
Expected: prints `PONG`.

- [ ] **Step 5: Verify the seed script runs against the live database**

Run: `pnpm --filter @us-os/database db:seed`
Expected: prints the two log lines from `prisma/seed.ts` and exits 0 (it connects and disconnects cleanly; there's nothing to seed yet since no models exist).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml packages/database/prisma/migrations
git commit -m "chore: add docker-compose for Postgres 16 and Redis, first migration"
```

---

### Task 6: `turbo.json` — Turborepo pipeline wiring

**Files:**
- Create: `turbo.json`

**Interfaces:**
- Consumes: the `dev`/`build`/`lint`/`test`/`typecheck` script names produced by Task 1 and every package task (2–5, 7, 8) — `turbo.json` task keys must match those script names exactly.

- [ ] **Step 1: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {},
    "typecheck": {},
    "test": {
      "outputs": ["coverage/**"]
    }
  }
}
```

`lint`, `typecheck`, and `test` deliberately have no `dependsOn: ["^build"]`. Every workspace package's `main`/`types` field points straight at its `src/` (not a compiled `dist/`), so downstream packages type-check and test against source directly — there's nothing built to wait on, and requiring it would only slow down local iteration for no correctness benefit. `build` keeps `dependsOn: ["^build"]` since it's the conventional Turborepo default for forward-compatibility (e.g. if a package later needs to consume a real compiled artifact from another package) — today it's a no-op since neither `@us-os/shared-types` nor `@us-os/database` has a `build` script, so Turborepo just skips them.

- [ ] **Step 2: Verify Turborepo picks up the two existing packages with typecheck/test tasks**

Run: `pnpm typecheck`
Expected: Turborepo runs `typecheck` for `@us-os/shared-types` and `@us-os/database` (the only packages with that script so far) and reports success for both, e.g. `Tasks: 2 successful, 2 total`.

- [ ] **Step 3: Commit**

```bash
git add turbo.json
git commit -m "chore: add turborepo pipeline config"
```

---

### Task 7: `apps/api` — NestJS service with a `/health` endpoint

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/nest-cli.json`
- Create: `apps/api/jest.config.js`
- Create: `apps/api/.eslintrc.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Test: `apps/api/src/health/health.controller.spec.ts`

**Interfaces:**
- Consumes: `HealthStatus` type from `@us-os/shared-types` (Task 3); `packages/config/tsconfig.base.json` (Task 2).
- Produces: a `GET /health` HTTP endpoint returning `{ status: 'ok', timestamp: string }`, verified live in Step 11.

- [ ] **Step 1: Write `apps/api/package.json`**

```json
{
  "name": "@us-os/api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "test": "jest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.6",
    "@nestjs/core": "^10.4.6",
    "@nestjs/platform-express": "^10.4.6",
    "@us-os/shared-types": "workspace:*",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.7",
    "@nestjs/schematics": "^10.2.3",
    "@nestjs/testing": "^10.4.6",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^22.9.0",
    "@types/supertest": "^6.0.2",
    "@typescript-eslint/eslint-plugin": "^8.14.0",
    "@typescript-eslint/parser": "^8.14.0",
    "eslint": "^8.57.1",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "typescript": "^5.6.3"
  }
}
```

`eslint` and `@typescript-eslint/*` are declared directly in this package (not inherited from the root or from `packages/config`'s ESLint preset) because the `lint` script below invokes the `eslint` CLI standalone, and NestJS apps conventionally carry their own `.eslintrc.json` tuned for decorator-heavy code (written in Step 5) rather than the plain-TS preset used by `packages/shared-types`/`packages/database`.

- [ ] **Step 2: Write `apps/api/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
```

- [ ] **Step 3: Write `apps/api/tsconfig.json`**

```json
{
  "extends": "../../packages/config/tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "target": "ES2022",
    "declaration": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Write `apps/api/jest.config.js`**

```js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
```

- [ ] **Step 5: Write `apps/api/.eslintrc.json`**

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": "tsconfig.json",
    "sourceType": "module"
  },
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "env": {
    "node": true,
    "jest": true
  },
  "ignorePatterns": ["dist", "node_modules"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "off"
  }
}
```

- [ ] **Step 6: Write the failing test — `apps/api/src/health/health.controller.spec.ts`**

```ts
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('returns status ok with a valid ISO timestamp', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });
});
```

- [ ] **Step 7: Install dependencies, then run the test to verify it fails**

Run: `pnpm install && pnpm --filter @us-os/api test`
Expected: FAIL — `Cannot find module './health.controller'`.

- [ ] **Step 8: Write the minimal implementation**

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import type { HealthStatus } from '@us-os/shared-types';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
```

`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
```

`apps/api/src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

bootstrap();
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @us-os/api test`
Expected: PASS — 1 test green.

- [ ] **Step 10: Verify lint passes**

Run: `pnpm --filter @us-os/api lint`
Expected: exits 0, no output (the `--fix` in the `lint` script auto-fixes trivial style issues; nothing should remain unfixable in this scaffold).

- [ ] **Step 11: Build and boot the API, then verify the endpoint live**

Run: `pnpm --filter @us-os/api build && (pnpm --filter @us-os/api start &) && sleep 2 && curl -s http://localhost:3001/health && echo && kill %1 2>/dev/null`
Expected: prints JSON like `{"status":"ok","timestamp":"2026-07-28T...Z"}`.

- [ ] **Step 12: Commit**

```bash
git add apps/api
git commit -m "feat: add NestJS api app with health endpoint"
```

---

### Task 8: `apps/web` — Next.js 14 App Router shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.js`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.js`
- Create: `apps/web/.eslintrc.json`
- Create: `apps/web/next-env.d.ts`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `HealthStatus` type from `@us-os/shared-types` (Task 3); `packages/config/tsconfig.base.json` (Task 2).
- Produces: a home page served at `/` proving the app builds, runs, and resolves the shared-types workspace package.

- [ ] **Step 1: Write `apps/web/package.json`**

```json
{
  "name": "@us-os/web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@us-os/shared-types": "workspace:*",
    "next": "^14.2.18",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "autoprefixer": "^10.4.20",
    "eslint": "^8.57.1",
    "eslint-config-next": "^14.2.18",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Write `apps/web/next.config.js`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
```

- [ ] **Step 3: Write `apps/web/tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 4: Write `apps/web/postcss.config.js`**

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Write `apps/web/.eslintrc.json`**

```json
{
  "extends": "next/core-web-vitals"
}
```

- [ ] **Step 6: Write `apps/web/tsconfig.json`**

```json
{
  "extends": "../../packages/config/tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "jsx": "preserve",
    "allowJs": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 7: Write `apps/web/next-env.d.ts`**

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

- [ ] **Step 8: Write `apps/web/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 9: Write `apps/web/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Relationship OS',
  description: 'A private, end-to-end encrypted workspace for couples.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 10: Write `apps/web/app/page.tsx`**

```tsx
import type { HealthStatus } from '@us-os/shared-types';

export default function HomePage() {
  // Constructed here (not module scope) so it reflects the actual render time.
  // This is a Server Component with no client-side re-render, so a
  // request-time timestamp cannot cause a hydration mismatch.
  const health: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };

  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Relationship OS</h1>
      <p>
        Monorepo foundation is running. Shared type check: {health.status} at {health.timestamp}
      </p>
    </main>
  );
}
```

- [ ] **Step 11: Install dependencies and build**

Run: `pnpm install && pnpm --filter @us-os/web build`
Expected: Next.js build completes with `Compiled successfully` and a static `/` route listed in the output.

- [ ] **Step 12: Boot the app and verify the home page live**

Run: `(pnpm --filter @us-os/web start &) && sleep 3 && curl -s http://localhost:3000 | grep -o 'Relationship OS' && kill %1 2>/dev/null`
Expected: prints `Relationship OS`.

- [ ] **Step 13: Commit**

```bash
git add apps/web
git commit -m "feat: add Next.js web app shell"
```

---

### Task 9: Full-monorepo verification

**Files:**
- None created — this task only runs cross-cutting verification across everything built in Tasks 1–8.

**Interfaces:**
- Consumes: every script and package produced in Tasks 1–8.

- [ ] **Step 1: Clean install from scratch**

Run: `rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install`
Expected: installs with no errors, lockfile unchanged (or updated deterministically).

- [ ] **Step 2: Run the full build pipeline**

Run: `pnpm build`
Expected: Turborepo reports all 3 buildable packages (`@us-os/shared-types` has no build script so it's skipped by Turbo, `@us-os/database`, `@us-os/api`, `@us-os/web`) succeed, e.g. `Tasks: 2 successful, 2 total` for build (api + web; database has no `build` script either, which is fine — Turbo skips packages missing a task).

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: `@us-os/shared-types` (3 tests) and `@us-os/api` (1 test) both pass; Turbo reports `Tasks: 2 successful, 2 total`.

- [ ] **Step 4: Run typecheck and lint across the workspace**

Run: `pnpm typecheck && pnpm lint`
Expected: `typecheck` exits 0 across the 4 packages that have that script (`@us-os/shared-types`, `@us-os/database`, `@us-os/api`, `@us-os/web`); `lint` exits 0 across the 3 packages that have that script (`@us-os/shared-types`, `@us-os/api`, `@us-os/web` — `@us-os/database` has no `lint` script and is skipped by Turbo).

- [ ] **Step 5: Verify the full local stack together**

If Task 5's containers are still running from earlier, `docker compose up -d --wait` below is a harmless no-op. Do **not** run `docker compose down` afterward here — that would tear down the shared dev Postgres/Redis containers other tasks (and ongoing local development) rely on. Stopping the stack is a separate, deliberate action the engineer takes when they're done for the session, not part of this verification.

Run:
```bash
docker compose up -d --wait
cp .env.example packages/database/.env
(pnpm --filter @us-os/api start &)
(pnpm --filter @us-os/web start &)
sleep 3
curl -s http://localhost:3001/health
echo
curl -s http://localhost:3000 | grep -o 'Relationship OS'
kill %1 %2 2>/dev/null
```
Expected: `/health` returns JSON with `"status":"ok"`, and the web page contains `Relationship OS`. The Postgres/Redis containers are left running.

- [ ] **Step 6: Commit (only if any fixes were needed in prior steps)**

```bash
git add -A
git commit -m "chore: verify full monorepo build/test/lint/dev pipeline"
```

If no fixes were needed, skip this step — there is nothing new to commit.
