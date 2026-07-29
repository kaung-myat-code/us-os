import { prisma } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation on decision tables (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };
  let userA: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Decisions Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Decisions Space B' } });
    userA = await prisma.user.create({
      data: { email: `rls-decisions-a-${Date.now()}@example.com`, passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.$disconnect();
  });

  it('isolates decisions, options, and trade-off items between spaces, queried directly on each table', async () => {
    const decisionA = await TenantContext.run(spaceA.id, () =>
      prisma.decision.create({ data: { spaceId: spaceA.id, createdBy: userA.id, title: 'A decision' } }),
    );
    const optionA = await TenantContext.run(spaceA.id, () =>
      prisma.decisionOption.create({ data: { spaceId: spaceA.id, decisionId: decisionA.id, label: 'A option' } }),
    );
    await TenantContext.run(spaceA.id, () =>
      prisma.tradeOffItem.create({
        data: { spaceId: spaceA.id, optionId: optionA.id, type: 'pro', label: 'A pro', weight: 3 },
      }),
    );

    // Direct queries from space B's context must see none of space A's rows,
    // on every one of the three tables — not just the top-level Decision.
    const decisionsFromB = await TenantContext.run(spaceB.id, () => prisma.decision.findMany());
    const optionsFromB = await TenantContext.run(spaceB.id, () => prisma.decisionOption.findMany());
    const tradeOffsFromB = await TenantContext.run(spaceB.id, () => prisma.tradeOffItem.findMany());

    expect(decisionsFromB).toEqual([]);
    expect(optionsFromB).toEqual([]);
    expect(tradeOffsFromB).toEqual([]);

    // And space A's own context still sees them.
    const decisionsFromA = await TenantContext.run(spaceA.id, () => prisma.decision.findMany());
    expect(decisionsFromA.map((d) => d.id)).toEqual([decisionA.id]);
  });
});
