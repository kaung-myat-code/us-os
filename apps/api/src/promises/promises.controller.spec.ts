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
import { PromisesModule } from './promises.module';

describe('PromisesController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, PromisesModule],
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
    const email = `promises-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  async function addPartner(
    creatorCookie: string[],
    label: string,
  ): Promise<{ cookie: string[]; email: string }> {
    const codeRes = await request(app.getHttpServer()).post('/spaces/pairing-codes').set('Cookie', creatorCookie).send({});
    const email = `promises-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const registerCookie = registerRes.headers['set-cookie'] as unknown as string[];
    const redeemRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', registerCookie)
      .send({ code: codeRes.body.code });
    return { cookie: redeemRes.headers['set-cookie'] as unknown as string[], email };
  }

  it('creates a promise as pending, with promisedBy set to the caller', async () => {
    const { cookie } = await registerWithSpace('create-basic');

    const res = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'Book the flights' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Book the flights');
    expect(res.body.status).toBe('pending');
    expect(res.body.resolvedAt).toBeNull();
    expect(res.body.resolvedBy).toBeNull();
    expect(typeof res.body.promisedBy).toBe('string');
  });

  it('round-trips a note and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('note-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookie)
      .send({ title: 'Book flights', note: 'Aisle seats please' });

    expect(created.body.note).toBe('Aisle seats please');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () => prisma.promise.findFirstOrThrow({ where: { id: created.body.id } }));
    expect(rawRow.noteCiphertext).not.toBeNull();
    expect(rawRow.noteCiphertext).not.toContain('Aisle seats please');
  });

  it('excludes another space’s promises from the list (RLS)', async () => {
    const { cookie: cookieA } = await registerWithSpace('rls-list-a');
    const { cookie: cookieB } = await registerWithSpace('rls-list-b');

    await request(app.getHttpServer()).post('/promises').set('Cookie', cookieA).send({ title: 'Space A promise' });

    const res = await request(app.getHttpServer()).get('/promises').set('Cookie', cookieB);
    expect(res.body.map((p: { title: string }) => p.title)).not.toContain('Space A promise');
  });

  it('lets the other partner (not just the promisor) resolve a promise', async () => {
    const creator = await registerWithSpace('resolve-partner-creator');
    const partner = await addPartner(creator.cookie, 'resolve-partner-joiner');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', creator.cookie)
      .send({ title: 'Do the dishes' });

    const resolved = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', partner.cookie)
      .send({ status: 'kept' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('kept');
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect(resolved.body.resolvedBy).not.toBe(created.body.promisedBy);
  });

  it('lets the promisor resolve their own promise', async () => {
    const { cookie } = await registerWithSpace('resolve-self');
    const created = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'Call the bank' });

    const resolved = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', cookie)
      .send({ status: 'broken' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('broken');
  });

  it('re-resolving overwrites status, resolvedAt, and resolvedBy, including to the same status again', async () => {
    const creator = await registerWithSpace('re-resolve-creator');
    const partner = await addPartner(creator.cookie, 're-resolve-joiner');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', creator.cookie)
      .send({ title: 'Pack the car' });

    const first = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', creator.cookie)
      .send({ status: 'kept' });
    expect(first.body.status).toBe('kept');

    const overwrite = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', partner.cookie)
      .send({ status: 'broken' });
    expect(overwrite.body.status).toBe('broken');
    expect(overwrite.body.resolvedBy).not.toBe(first.body.resolvedBy);

    const sameStatusAgain = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', partner.cookie)
      .send({ status: 'broken' });
    expect(sameStatusAgain.status).toBe(200);
    expect(sameStatusAgain.body.status).toBe('broken');
  });

  it('rejects resolving to pending with 400', async () => {
    const { cookie } = await registerWithSpace('resolve-pending-rejected');
    const created = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'x' });

    const res = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', cookie)
      .send({ status: 'pending' });
    expect(res.status).toBe(400);
  });

  it('deletes a promise', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: 'To delete' });

    const deleteRes = await request(app.getHttpServer()).delete(`/promises/${created.body.id}`).set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/promises').set('Cookie', cookie);
    expect(listRes.body.map((p: { id: string }) => p.id)).not.toContain(created.body.id);
  });

  it('returns 404 (not 403) when getting, updating, resolving, or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookieA)
      .send({ title: 'Space A promise' });

    const getRes = await request(app.getHttpServer()).get(`/promises/${created.body.id}`).set('Cookie', cookieB);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const resolveRes = await request(app.getHttpServer())
      .patch(`/promises/${created.body.id}/resolve`)
      .set('Cookie', cookieB)
      .send({ status: 'kept' });
    expect(resolveRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer()).delete(`/promises/${created.body.id}`).set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer()).post('/promises').set('Cookie', cookie).send({ title: '' });
    expect(emptyTitle.status).toBe(400);

    const titleTooLong = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookie)
      .send({ title: 'a'.repeat(201) });
    expect(titleTooLong.status).toBe(400);

    const noteTooLong = await request(app.getHttpServer())
      .post('/promises')
      .set('Cookie', cookie)
      .send({ title: 'x', note: 'a'.repeat(10001) });
    expect(noteTooLong.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all promise endpoints', async () => {
    const getRes = await request(app.getHttpServer()).get('/promises');
    const postRes = await request(app.getHttpServer()).post('/promises').send({ title: 'x' });
    const patchRes = await request(app.getHttpServer()).patch('/promises/00000000-0000-0000-0000-000000000000').send({});
    const resolveRes = await request(app.getHttpServer())
      .patch('/promises/00000000-0000-0000-0000-000000000000/resolve')
      .send({ status: 'kept' });
    const deleteRes = await request(app.getHttpServer()).delete('/promises/00000000-0000-0000-0000-000000000000');

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(resolveRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});
