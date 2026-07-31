import { prisma } from '../src/client';
import { TenantContext } from '../src/tenant-context';

describe('RLS tenant isolation on goals and promises (integration)', () => {
  let spaceA: { id: string };
  let spaceB: { id: string };
  let userA: { id: string };

  beforeAll(async () => {
    spaceA = await prisma.space.create({ data: { name: 'Goals Space A' } });
    spaceB = await prisma.space.create({ data: { name: 'Goals Space B' } });
    userA = await prisma.user.create({
      data: { email: `rls-goals-a-${Date.now()}@example.com`, passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    await prisma.space.delete({ where: { id: spaceA.id } });
    await prisma.space.delete({ where: { id: spaceB.id } });
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.$disconnect();
  });

  it('isolates goals between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.goal.create({ data: { spaceId: spaceA.id, createdBy: userA.id, title: 'A goal' } }),
    );

    const goalsFromB = await TenantContext.run(spaceB.id, () => prisma.goal.findMany());
    expect(goalsFromB).toEqual([]);

    const goalsFromA = await TenantContext.run(spaceA.id, () => prisma.goal.findMany());
    expect(goalsFromA.map((g) => g.title)).toEqual(['A goal']);
  });

  it('isolates promises between spaces', async () => {
    await TenantContext.run(spaceA.id, () =>
      prisma.promise.create({ data: { spaceId: spaceA.id, promisedBy: userA.id, title: 'A promise' } }),
    );

    const promisesFromB = await TenantContext.run(spaceB.id, () => prisma.promise.findMany());
    expect(promisesFromB).toEqual([]);

    const promisesFromA = await TenantContext.run(spaceA.id, () => prisma.promise.findMany());
    expect(promisesFromA.map((p) => p.title)).toEqual(['A promise']);
  });
});
