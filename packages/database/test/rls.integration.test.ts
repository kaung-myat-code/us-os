import { prisma, withTenantTransaction } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Space B' } });
    userA = await prisma.user.create({
      data: { email: `rls-a-${Date.now()}@example.com`, passwordHash: 'x' },
    });
    userB = await prisma.user.create({
      data: { email: `rls-b-${Date.now()}@example.com`, passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    // Spaces first: deleting them cascades their milestones, which is a
    // prerequisite for deleting the users below (created_by is a
    // RESTRICT-on-delete FK).
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.user.delete({ where: { id: userB.id } });
    await prisma.$disconnect();
  });

  it('isolates milestones between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.milestone.create({
        data: { spaceId: spaceA.id, createdBy: userA.id, title: 'A milestone', eventDate: new Date() },
      }),
    );
    await TenantContext.run(spaceB.id, () =>
      prisma.milestone.create({
        data: { spaceId: spaceB.id, createdBy: userB.id, title: 'B milestone', eventDate: new Date() },
      }),
    );

    const seenFromA = await TenantContext.run(spaceA.id, () => prisma.milestone.findMany());
    const seenFromB = await TenantContext.run(spaceB.id, () => prisma.milestone.findMany());

    expect(seenFromA.map((m) => m.title)).toEqual(['A milestone']);
    expect(seenFromB.map((m) => m.title)).toEqual(['B milestone']);
  });

  it('throws before issuing SQL when no TenantContext is set', async () => {
    await expect(prisma.milestone.findMany()).rejects.toThrow(
      'TenantContext: no space set for Milestone.findMany',
    );
  });

  it('rejects a cross-tenant write at the database level', async () => {
    await expect(
      TenantContext.run(spaceA.id, () =>
        prisma.milestone.create({
          data: { spaceId: spaceB.id, createdBy: userA.id, title: 'sneaky', eventDate: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it('fails closed (zero rows) when the session variable is an empty string', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_space_id', '', true)`;
      const rows = await tx.milestone.findMany();
      expect(rows).toEqual([]);
    });
  });

  it('rolls back all writes in withTenantTransaction if one fails', async () => {
    const before = await TenantContext.run(spaceA.id, () => prisma.milestone.count());

    await expect(
      TenantContext.run(spaceA.id, () =>
        withTenantTransaction(async (tx) => {
          await tx.milestone.create({
            data: { spaceId: spaceA.id, createdBy: userA.id, title: 'will be rolled back', eventDate: new Date() },
          });
          // Second write in the same atomic operation fails (foreign spaceId, WITH CHECK rejects it).
          await tx.milestone.create({
            data: { spaceId: spaceB.id, createdBy: userA.id, title: 'invalid', eventDate: new Date() },
          });
        }),
      ),
    ).rejects.toThrow();

    const after = await TenantContext.run(spaceA.id, () => prisma.milestone.count());
    expect(after).toBe(before);
  });

  it('reuses the active transaction when withTenantTransaction is nested, rather than opening a second one', async () => {
    let innerTx: unknown;
    let outerTx: unknown;

    await TenantContext.run(spaceA.id, () =>
      withTenantTransaction(async (tx) => {
        outerTx = tx;
        await withTenantTransaction(async (nestedTx) => {
          innerTx = nestedTx;
        });
      }),
    );

    expect(innerTx === outerTx).toBe(true);
  });

  it('rolls back the outer transaction when a nested withTenantTransaction call fails', async () => {
    const before = await TenantContext.run(spaceA.id, () => prisma.milestone.count());

    await expect(
      TenantContext.run(spaceA.id, () =>
        withTenantTransaction(async (outerTx) => {
          await outerTx.milestone.create({
            data: { spaceId: spaceA.id, createdBy: userA.id, title: 'outer write', eventDate: new Date() },
          });
          // Nested call reuses the outer transaction, so its failure rolls back
          // the outer write above too, not just its own.
          await withTenantTransaction(async (innerTx) => {
            await innerTx.milestone.create({
              data: { spaceId: spaceB.id, createdBy: userA.id, title: 'invalid nested write', eventDate: new Date() },
            });
          });
        }),
      ),
    ).rejects.toThrow();

    const after = await TenantContext.run(spaceA.id, () => prisma.milestone.count());
    expect(after).toBe(before);
  });
});
