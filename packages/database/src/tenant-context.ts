import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

type Store = { spaceId: string; tx?: Prisma.TransactionClient };

const als = new AsyncLocalStorage<Store>();

export const TenantContext = {
  run<T>(spaceId: string, fn: () => T): T {
    return als.run({ spaceId }, fn);
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
