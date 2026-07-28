import type { Prisma } from '@prisma/client';
import { TenantContext } from './tenant-context';

describe('TenantContext', () => {
  it('exposes the space id set by run() inside the callback', () => {
    TenantContext.run('space-a', () => {
      expect(TenantContext.currentSpaceId).toBe('space-a');
      expect(TenantContext.spaceId).toBe('space-a');
    });
  });

  it('returns undefined from currentSpaceId outside any run() call', () => {
    expect(TenantContext.currentSpaceId).toBeUndefined();
  });

  it('throws from the strict spaceId getter outside any run() call', () => {
    expect(() => TenantContext.spaceId).toThrow('TenantContext: no space set for this request');
  });

  it('isolates context between concurrent run() calls', async () => {
    const results: string[] = [];
    await Promise.all([
      new Promise<void>((resolve) =>
        TenantContext.run('space-a', () => {
          setTimeout(() => {
            results.push(TenantContext.spaceId);
            resolve();
          }, 10);
        }),
      ),
      new Promise<void>((resolve) =>
        TenantContext.run('space-b', () => {
          setTimeout(() => {
            results.push(TenantContext.spaceId);
            resolve();
          }, 5);
        }),
      ),
    ]);
    expect(results.sort()).toEqual(['space-a', 'space-b']);
  });

  it('has no activeTx by default, and exposes one set via runWithTx', () => {
    TenantContext.run('space-a', () => {
      expect(TenantContext.activeTx).toBeUndefined();
      const fakeTx = {} as Prisma.TransactionClient;
      TenantContext.runWithTx(fakeTx, () => {
        expect(TenantContext.activeTx).toBe(fakeTx);
        expect(TenantContext.spaceId).toBe('space-a');
      });
    });
  });

  it('throws from runWithTx if no space context is active', () => {
    const fakeTx = {} as Prisma.TransactionClient;
    expect(() => TenantContext.runWithTx(fakeTx, () => undefined)).toThrow(
      'TenantContext: runWithTx requires an active space context',
    );
  });
});
