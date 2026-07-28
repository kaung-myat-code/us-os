# Relationship OS — Claude Code Memory & Guidelines

## 1. Project Overview & Architecture
- **Project Name**: Relationship OS.
- **Description**: A private, end-to-end encrypted collaborative workspace for couples to log timeline milestones, frame structured decisions, track long-term goals, and store media securely.
- **Architecture**: Turborepo monorepo structure:
  - `apps/web`: Next.js 14+ PWA frontend (App Router, Tailwind CSS, Shadcn/UI, Zustand, IndexedDB).
  - `apps/api`: NestJS backend REST API (TypeScript, Prisma/Drizzle ORM, Passport Auth).
  - `packages/database`: Database schemas, Prisma/Drizzle models, and SQL migration scripts.
  - `packages/shared-types`: Shared TypeScript interfaces and Zod validation schemas.
  - `packages/config`: Shared ESLint, Prettier, TypeScript, and Tailwind configurations.
- **Infrastructure**: PostgreSQL 16 (Row-Level Security enabled), Redis (BullMQ queues & caching), Cloudflare R2 / S3 (Media Object Storage).

---

## 2. Key Commands & Scripts

### Development & Workspace
- `pnpm dev`: Start all apps (Next.js web and NestJS API) concurrently via Turborepo.
- `pnpm dev --filter=web`: Run only the Next.js frontend app.
- `pnpm dev --filter=api`: Run only the NestJS backend API.
- `pnpm build`: Run production builds across all applications.

### Database & Migrations
- `pnpm db:migrate`: Run pending PostgreSQL migrations in `packages/database`.
- `pnpm db:generate`: Generate Prisma/Drizzle client types.
- `pnpm db:studio`: Launch ORM database browser.
- `pnpm db:seed`: Seed local PostgreSQL database with development test spaces.

### Testing & Code Quality
- `pnpm test`: Execute all unit and integration tests.
- `pnpm test:e2e`: Execute Playwright end-to-end test suite.
- `pnpm lint`: Run ESLint across all apps and packages.
- `pnpm typecheck`: Run TypeScript compiler checks across all workspaces.

---

## 3. Core Technical & Security Guidelines

### Multi-Tenancy & Data Isolation (CRITICAL)
- All PostgreSQL database queries must enforce Row-Level Security (RLS) keyed on `space_id`.
- Database sessions must set the current tenant before executing queries (`SET LOCAL app.current_space_id = 'space_uuid'`).
- Data leak between spaces is considered a critical security violation.

### Encryption & Privacy
- Sensitive fields (notes, decision rationales, raw unstructured messages) must be encrypted at rest using AES-256-GCM envelope encryption.
- Presigned URLs must be used for direct-to-S3 media uploads; raw media binaries must not pass through the main API server.

### API & Validation Standard
- Shared DTO payloads between Next.js and NestJS must be validated using Zod schemas defined in `packages/shared-types`.
- API responses must adhere to RFC 7807 Problem Details format for error handling.
- Latency threshold targets: P95 API response time must remain under 150ms.

---

## 4. Superpowers & AI Engineering Workflow Rules

1. **Spec-Driven Planning**:
   - Before executing multi-file implementation tasks, use `/superpowers:brainstorm` to clarify requirements or `/superpowers:write-plan` to generate granular step-by-step implementation plans.
2. **Test-Driven Development (TDD)**:
   - Always write or update tests before or alongside code implementation.
   - Ensure all unit, integration, and RLS policy tests pass before completing a task.
3. **Incremental Commits**:
   - Keep code changes focused and scoped to single functional steps.
   - Do not make sweeping refactors outside the assigned task without updating the implementation plan first.
