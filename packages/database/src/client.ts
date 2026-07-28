import { Prisma, PrismaClient } from '@prisma/client';
import { TenantContext } from './tenant-context';

const globalForPrisma = globalThis as unknown as { basePrisma: PrismaClient | undefined };

// APP_DATABASE_URL must point at a non-superuser, NOBYPASSRLS role. DATABASE_URL
// (used by `prisma migrate`/`generate`) is a superuser bootstrap role that would
// silently bypass every RLS policy if used here. See packages/database/.env.example.
const basePrisma =
  globalForPrisma.basePrisma ??
  new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.basePrisma = basePrisma;
}

const TENANT_SCOPED_MODELS = new Set(['Milestone']);

// prisma.$transaction() deliberately delegates to the un-extended basePrisma's
// $transaction rather than going through the query extension below: the `tx`
// it yields is then unextended too, so calls on it skip the TenantContext
// guard entirely. Callers using this raw escape hatch take on responsibility
// for the session variable themselves (as withTenantTransaction does
// internally) and rely on the DB-level RLS policy to fail closed — see the
// design spec's Safety Invariant section.
const rawTransaction = basePrisma.$transaction.bind(basePrisma) as PrismaClient['$transaction'];

export const prisma = basePrisma.$extends({
  client: {
    $transaction: rawTransaction,
  },
  query: {
    $allOperations: async ({ model, operation, args, query }) => {
      if (!model || !TENANT_SCOPED_MODELS.has(model)) {
        return query(args);
      }
      const camelModel = (model.charAt(0).toLowerCase() + model.slice(1)) as 'milestone';

      const activeTx = TenantContext.activeTx;
      if (activeTx) {
        return (activeTx as unknown as Record<string, any>)[camelModel][operation](args);
      }

      const spaceId = TenantContext.currentSpaceId;
      if (!spaceId) throw new Error(`TenantContext: no space set for ${model}.${operation}`);

      return basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_space_id', ${spaceId}, true)`;
        return (tx as unknown as Record<string, any>)[camelModel][operation](args);
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
