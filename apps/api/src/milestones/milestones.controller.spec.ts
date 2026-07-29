import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
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
});
