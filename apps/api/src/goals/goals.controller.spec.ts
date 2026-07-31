import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma, TenantContext } from '@us-os/database';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { SpacesModule } from '../spaces/spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { GoalsModule } from './goals.module';

describe('GoalsController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, GoalsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    const tenantMiddleware = new TenantMiddleware(moduleRef.get(SessionService));
    app.use((req: Request, res: Response, next: NextFunction) => tenantMiddleware.use(req, res, next));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: createdEmails } },
      include: { memberships: true },
    });
    const spaceIds = users.flatMap((user) => user.memberships.map((membership) => membership.spaceId));
    await prisma.space.deleteMany({ where: { id: { in: spaceIds } } });
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerWithSpace(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `goals-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const registerCookie = registerRes.headers['set-cookie'] as unknown as string[];

    const spaceRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', registerCookie)
      .send({ name: `${label} space` });
    const spaceCookie = spaceRes.headers['set-cookie'] as unknown as string[];

    return { cookie: spaceCookie, email };
  }

  it('creates a goal with defaults when only a title is given', async () => {
    const { cookie } = await registerWithSpace('create-defaults');

    const res = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'Run a marathon' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Run a marathon');
    expect(res.body.category).toBe('other');
    expect(res.body.progress).toBe(0);
    expect(res.body.status).toBe('active');
    expect(res.body.achievedAt).toBeNull();
    expect(res.body.description).toBeNull();
  });

  it('round-trips a description and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('description-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', cookie)
      .send({ title: 'Save for a house', category: 'financial', description: 'Aiming to avoid PMI' });

    expect(created.body.description).toBe('Aiming to avoid PMI');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () => prisma.goal.findFirstOrThrow({ where: { id: created.body.id } }));
    expect(rawRow.descriptionCiphertext).not.toBeNull();
    expect(rawRow.descriptionCiphertext).not.toContain('Aiming to avoid PMI');
  });

  it('excludes another space’s goals from the list (RLS)', async () => {
    const { cookie: cookieA } = await registerWithSpace('rls-list-a');
    const { cookie: cookieB } = await registerWithSpace('rls-list-b');

    await request(app.getHttpServer()).post('/goals').set('Cookie', cookieA).send({ title: 'Space A goal' });

    const res = await request(app.getHttpServer()).get('/goals').set('Cookie', cookieB);
    expect(res.body.map((g: { title: string }) => g.title)).not.toContain('Space A goal');
  });

  it('updates progress and status independently, in any combination', async () => {
    const { cookie } = await registerWithSpace('progress-status');
    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'Half marathon' });

    const res1 = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ progress: 100, status: 'active' });
    expect(res1.status).toBe(200);
    expect(res1.body.progress).toBe(100);
    expect(res1.body.status).toBe('active');

    const res2 = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ progress: 55, status: 'achieved' });
    expect(res2.status).toBe(200);
    expect(res2.body.progress).toBe(55);
    expect(res2.body.status).toBe('achieved');
  });

  it('sets achievedAt on transition to achieved, and clears it on transition away', async () => {
    const { cookie } = await registerWithSpace('achieved-at');
    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'Learn Spanish' });

    const achieved = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'achieved' });
    expect(achieved.body.achievedAt).not.toBeNull();

    const stillAchieved = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Learn Spanish fluently' });
    expect(stillAchieved.body.achievedAt).toBe(achieved.body.achievedAt);

    const reactivated = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    expect(reactivated.body.achievedAt).toBeNull();
  });

  it('deletes a goal', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'To delete' });

    const deleteRes = await request(app.getHttpServer()).delete(`/goals/${created.body.id}`).set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/goals').set('Cookie', cookie);
    expect(listRes.body.map((g: { id: string }) => g.id)).not.toContain(created.body.id);
  });

  it('either partner in the space may edit and delete a goal the other created', async () => {
    const creator = await registerWithSpace('either-partner-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `goals-either-partner-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(joinerEmail);
    const joinerRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: joinerEmail, password: 'supersecret' });
    const joinerRegisterCookie = joinerRegister.headers['set-cookie'] as unknown as string[];
    const joinerRedeem = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', joinerRegisterCookie)
      .send({ code: codeRes.body.code });
    const joinerCookie = joinerRedeem.headers['set-cookie'] as unknown as string[];

    const created = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator goal' });

    const editByJoiner = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', joinerCookie)
      .send({ title: 'Edited by joiner' });
    expect(editByJoiner.status).toBe(200);

    const deleteByJoiner = await request(app.getHttpServer()).delete(`/goals/${created.body.id}`).set('Cookie', joinerCookie);
    expect(deleteByJoiner.status).toBe(204);
  });

  it('returns 404 (not 403) when getting, updating, or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', cookieA)
      .send({ title: 'Space A goal' });

    const getRes = await request(app.getHttpServer()).get(`/goals/${created.body.id}`).set('Cookie', cookieB);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer()).delete(`/goals/${created.body.id}`).set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create and update', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: '' });
    expect(emptyTitle.status).toBe(400);

    const badCategory = await request(app.getHttpServer())
      .post('/goals')
      .set('Cookie', cookie)
      .send({ title: 'x', category: 'hobby' });
    expect(badCategory.status).toBe(400);

    const created = await request(app.getHttpServer()).post('/goals').set('Cookie', cookie).send({ title: 'x' });

    const badProgress = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ progress: 150 });
    expect(badProgress.status).toBe(400);

    const badStatus = await request(app.getHttpServer())
      .patch(`/goals/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'paused' });
    expect(badStatus.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all goal endpoints', async () => {
    const getRes = await request(app.getHttpServer()).get('/goals');
    const postRes = await request(app.getHttpServer()).post('/goals').send({ title: 'x' });
    const patchRes = await request(app.getHttpServer()).patch('/goals/00000000-0000-0000-0000-000000000000').send({});
    const deleteRes = await request(app.getHttpServer()).delete('/goals/00000000-0000-0000-0000-000000000000');

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});
