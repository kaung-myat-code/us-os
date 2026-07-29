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
import { MilestonesModule } from './milestones.module';

describe('MilestonesController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    // Milestone is a tenant-scoped model (see TENANT_SCOPED_MODELS in
    // @us-os/database), so its queries need TenantContext set from the
    // request's JWT cookie. In the real app this comes from
    // AppModule.configure(), which isn't part of this module graph, so it's
    // replicated here the same way AppModule wires it (cookieParser, then
    // TenantMiddleware, on every route).
    const tenantMiddleware = new TenantMiddleware(moduleRef.get(SessionService));
    app.use((req: Request, res: Response, next: NextFunction) => tenantMiddleware.use(req, res, next));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    // Spaces first: deleting them cascades their milestones and memberships,
    // a prerequisite for deleting the users below (milestones.created_by is
    // a RESTRICT-on-delete FK — see rls.integration.test.ts for the same
    // pattern).
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
    const email = `milestones-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  it('creates a milestone without a note', async () => {
    const { cookie } = await registerWithSpace('create-basic');

    const res = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'First apartment', eventDate: '2024-03-15', category: 'milestone' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('First apartment');
    expect(res.body.eventDate).toBe('2024-03-15');
    expect(res.body.note).toBeNull();
  });

  it('lists milestones oldest-first by eventDate', async () => {
    const { cookie } = await registerWithSpace('list-order');

    await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Second', eventDate: '2024-06-01' });
    await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'First', eventDate: '2024-01-01' });

    const res = await request(app.getHttpServer()).get('/milestones').set('Cookie', cookie);

    expect(res.body.map((m: { title: string }) => m.title)).toEqual(['First', 'Second']);
  });

  it('updates a milestone', async () => {
    const { cookie } = await registerWithSpace('update-basic');
    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Original', eventDate: '2024-01-01' });

    const res = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
  });

  it('deletes a milestone', async () => {
    const { cookie } = await registerWithSpace('delete-basic');
    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'To delete', eventDate: '2024-01-01' });

    const deleteRes = await request(app.getHttpServer())
      .delete(`/milestones/${created.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/milestones').set('Cookie', cookie);
    expect(listRes.body.map((m: { id: string }) => m.id)).not.toContain(created.body.id);
  });

  it('rejects requests without a session cookie with 401', async () => {
    const res = await request(app.getHttpServer()).get('/milestones');
    expect(res.status).toBe(401);
  });

  it('round-trips a note and stores it encrypted (not plaintext) in the database', async () => {
    const { cookie } = await registerWithSpace('note-roundtrip');

    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'First apartment', eventDate: '2024-03-15', note: 'We moved in together' });

    expect(created.body.note).toBe('We moved in together');

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    const rawRow = await TenantContext.run(spaceId, () =>
      prisma.milestone.findFirstOrThrow({ where: { id: created.body.id } }),
    );
    expect(rawRow.noteCiphertext).not.toBeNull();
    expect(rawRow.noteCiphertext).not.toContain('We moved in together');
  });

  it('normalizes a whitespace-only note to null on create', async () => {
    const { cookie } = await registerWithSpace('note-whitespace-create');

    const res = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', note: '   ' });

    expect(res.body.note).toBeNull();
  });

  it('PATCH note: "text" re-encrypts, null clears, omitted leaves untouched', async () => {
    const { cookie } = await registerWithSpace('note-three-state');
    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', note: 'original note' });

    const reencrypted = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ note: 'new text' });
    expect(reencrypted.body.note).toBe('new text');

    const untouched = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ title: 'renamed only' });
    expect(untouched.body.note).toBe('new text');

    const cleared = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ note: null });
    expect(cleared.body.note).toBeNull();

    const clearedByWhitespace = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'y', eventDate: '2024-01-01', note: 'has a note' });
    const clearedRes = await request(app.getHttpServer())
      .patch(`/milestones/${clearedByWhitespace.body.id}`)
      .set('Cookie', cookie)
      .send({ note: '   ' });
    expect(clearedRes.body.note).toBeNull();
  });

  it('recovers from a corrupted note: GET still returns 200 with note null, rest of list intact', async () => {
    const { cookie } = await registerWithSpace('note-corrupt');
    const good = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Good entry', eventDate: '2024-01-01', note: 'readable note' });
    const corrupted = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'Corrupted entry', eventDate: '2024-02-01', note: 'will be corrupted' });

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    const spaceId = meRes.body.space.id as string;
    await TenantContext.run(spaceId, () =>
      prisma.milestone.update({
        where: { id: corrupted.body.id },
        data: { noteAuthTag: Buffer.from('0'.repeat(16)).toString('base64') },
      }),
    );

    const listRes = await request(app.getHttpServer()).get('/milestones').set('Cookie', cookie);
    expect(listRes.status).toBe(200);
    const byId = new Map(listRes.body.map((m: { id: string; note: string | null }) => [m.id, m.note]));
    expect(byId.get(corrupted.body.id)).toBeNull();
    expect(byId.get(good.body.id)).toBe('readable note');
  });

  it('either partner in the space may edit and delete an entry the other created', async () => {
    const creator = await registerWithSpace('either-partner-creator');
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});
    const joinerEmail = `milestones-either-partner-joiner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
      .post('/milestones')
      .set('Cookie', creator.cookie)
      .send({ title: 'Creator entry', eventDate: '2024-01-01' });

    const editByJoiner = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', joinerCookie)
      .send({ title: 'Edited by joiner' });
    expect(editByJoiner.status).toBe(200);
    expect(editByJoiner.body.createdBy).not.toBe(editByJoiner.body.id);

    const deleteByJoiner = await request(app.getHttpServer())
      .delete(`/milestones/${created.body.id}`)
      .set('Cookie', joinerCookie);
    expect(deleteByJoiner.status).toBe(204);
  });

  it('returns 404 (not 403) when updating or deleting an id belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-b');

    const created = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookieA)
      .send({ title: 'Space A entry', eventDate: '2024-01-01' });

    const patchRes = await request(app.getHttpServer())
      .patch(`/milestones/${created.body.id}`)
      .set('Cookie', cookieB)
      .send({ title: 'hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app.getHttpServer())
      .delete(`/milestones/${created.body.id}`)
      .set('Cookie', cookieB);
    expect(deleteRes.status).toBe(404);
  });

  it('rejects invalid payloads with 400 on create', async () => {
    const { cookie } = await registerWithSpace('validation');

    const emptyTitle = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: '', eventDate: '2024-01-01' });
    expect(emptyTitle.status).toBe(400);

    const badCategory = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', category: 'vacation' });
    expect(badCategory.status).toBe(400);

    const badDate = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01T10:30:00Z' });
    expect(badDate.status).toBe(400);

    const noteTooLong = await request(app.getHttpServer())
      .post('/milestones')
      .set('Cookie', cookie)
      .send({ title: 'x', eventDate: '2024-01-01', note: 'a'.repeat(10001) });
    expect(noteTooLong.status).toBe(400);
  });

  it('rejects requests without a session cookie with 401 on all four endpoints', async () => {
    const patchRes = await request(app.getHttpServer()).patch('/milestones/00000000-0000-0000-0000-000000000000');
    const deleteRes = await request(app.getHttpServer()).delete('/milestones/00000000-0000-0000-0000-000000000000');
    const postRes = await request(app.getHttpServer()).post('/milestones').send({});

    expect(patchRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
    expect(postRes.status).toBe(401);
  });
});
