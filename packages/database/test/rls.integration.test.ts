import { prisma, withTenantTransaction } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Space B' } });
  });

  afterAll(async () => {
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.$disconnect();
  });

  it('isolates milestones between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.milestone.create({
        data: { spaceId: spaceA.id, title: 'A milestone', occurredAt: new Date() },
      }),
    );
    await TenantContext.run(spaceB.id, () =>
      prisma.milestone.create({
        data: { spaceId: spaceB.id, title: 'B milestone', occurredAt: new Date() },
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
          data: { spaceId: spaceB.id, title: 'sneaky', occurredAt: new Date() },
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
            data: { spaceId: spaceA.id, title: 'will be rolled back', occurredAt: new Date() },
          });
          // Second write in the same atomic operation fails (foreign spaceId, WITH CHECK rejects it).
          await tx.milestone.create({
            data: { spaceId: spaceB.id, title: 'invalid', occurredAt: new Date() },
          });
        }),
      ),
    ).rejects.toThrow();

    const after = await TenantContext.run(spaceA.id, () => prisma.milestone.count());
    expect(after).toBe(before);
  });
});
