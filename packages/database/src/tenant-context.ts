import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

type Store = { spaceId: string; tx?: Prisma.TransactionClient };

const als = new AsyncLocalStorage<Store>();

function touchThenable<T>(value: T): T {
  // Prisma's query builders are lazy thenables: the actual query (and thus
  // any Prisma Client Extension hooks) doesn't run until `.then()` is first
  // called. If that happens after run()'s synchronous callback has already
  // returned, AsyncLocalStorage's context has already been torn down. Calling
  // `.then()` here, synchronously, while the store is still active, forces
  // the query to start inside the context without altering what the caller
  // ultimately awaits.
  if (value && typeof (value as unknown as { then?: unknown }).then === 'function') {
    (value as unknown as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
  }
  return value;
}

export const TenantContext = {
  run<T>(spaceId: string, fn: () => T): T {
    return als.run({ spaceId }, () => touchThenable(fn()));
  },

  get currentSpaceId(): string | undefined {
    return als.getStore()?.spaceId;
  },

  get spaceId(): string {
    const spaceId = this.currentSpaceId;
    if (!spaceId) throw new Error('TenantContext: no space set for this request');
    return spaceId;
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
