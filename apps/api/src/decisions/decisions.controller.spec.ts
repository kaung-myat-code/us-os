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
import { DecisionsModule } from './decisions.module';

describe('DecisionsController — decision CRUD (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, DecisionsModule],
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
    const email = `decisions-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  it('creates a decision without a rationale', async () => {
    const { cookie } = await registerWithSpace('create-basic');

    const res = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Where should we live?' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Where should we live?');
    expect(res.body.status).toBe('open');
    expect(res.body.rationale).toBeNull();
    expect(res.body.options).toEqual([]);
  });

  it('round-trips a rationale and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('rationale-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Job offer', rationale: "We're outgrowing our apartment" });

    expect(created.body.rationale).toBe("We're outgrowing our apartment");

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () =>
      prisma.decision.findFirstOrThrow({ where: { id: created.body.id } }),
    );
    expect(rawRow.rationaleCiphertext).not.toBeNull();
    expect(rawRow.rationaleCiphertext).not.toContain("We're outgrowing our apartment");
  });

  it('lists decisions without a nested options field or outcomeNote', async () => {
    const { cookie } = await registerWithSpace('list-shape');

    await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Decision X', rationale: 'context' });

    const res = await request(app.getHttpServer()).get('/decisions').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body[0].title).toBe('Decision X');
    expect(res.body[0].rationale).toBe('context');
    expect('options' in res.body[0]).toBe(false);
    expect('outcomeNote' in res.body[0]).toBe(false);
  });

  it('excludes another space’s decisions from the list (RLS)', async () => {
    const { cookie: cookieA } = await registerWithSpace('rls-list-a');
    const { cookie: cookieB } = await registerWithSpace('rls-list-b');

    await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookieA)
      .send({ title: 'Space A decision' });

    const res = await request(app.getHttpServer()).get('/decisions').set('Cookie', cookieB);
    expect(res.body.map((d: { title: string }) => d.title)).not.toContain('Space A decision');
  });

  it('gets a decision detail with an empty options array', async () => {
    const { cookie } = await registerWithSpace('get-detail');
    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Detail test' });

    const res = await request(app.getHttpServer()).get(`/decisions/${created.body.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual([]);
    expect(res.body.outcomeNote).toBeNull();
    expect(res.body.chosenOptionId).toBeNull();
  });

  it('updates a decision title and rationale', async () => {
    const { cookie } = await registerWithSpace('update-basic');
    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'Original' });

    const res = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Updated', rationale: 'new context' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
    expect(res.body.rationale).toBe('new context');
  });

  it('deletes a decision', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'To delete' });

    const deleteRes = await request(app.getHttpServer()).delete(`/decisions/${created.body.id}`).set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/decisions').set('Cookie', cookie);
    expect(listRes.body.map((d: { id: string }) => d.id)).not.toContain(created.body.id);
  });

  it('either partner in the space may edit and delete a decision the other created', async () => {
    const creator = await registerWithSpace('either-partner-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `decisions-either-partner-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
      .post('/decisions')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator decision' });

    const editByJoiner = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}`)
      .set('Cookie', joinerCookie)
      .send({ title: 'Edited by joiner' });
    expect(editByJoiner.status).toBe(200);

    const deleteByJoiner = await request(app.getHttpServer())
      .delete(`/decisions/${created.body.id}`)
      .set('Cookie', joinerCookie);
    expect(deleteByJoiner.status).toBe(204);
  });

  it('returns 404 (not 403) when getting, updating, or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookieA)
      .send({ title: 'Space A decision' });

    const getRes = await request(app.getHttpServer()).get(`/decisions/${created.body.id}`).set('Cookie', cookieB);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app.getHttpServer())
      .patch(`/decisions/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer()).delete(`/decisions/${created.body.id}`).set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title: '' });
    expect(emptyTitle.status).toBe(400);

    const titleTooLong = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'a'.repeat(201) });
    expect(titleTooLong.status).toBe(400);

    const rationaleTooLong = await request(app.getHttpServer())
      .post('/decisions')
      .set('Cookie', cookie)
      .send({ title: 'x', rationale: 'a'.repeat(10001) });
    expect(rationaleTooLong.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all decision-level endpoints', async () => {
    const getRes = await request(app.getHttpServer()).get('/decisions');
    const postRes = await request(app.getHttpServer()).post('/decisions').send({ title: 'x' });
    const patchRes = await request(app.getHttpServer()).patch('/decisions/00000000-0000-0000-0000-000000000000').send({});
    const deleteRes = await request(app.getHttpServer()).delete('/decisions/00000000-0000-0000-0000-000000000000');

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});
