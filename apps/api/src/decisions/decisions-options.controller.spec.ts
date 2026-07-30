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
import { DecisionsModule } from './decisions.module';

describe('DecisionsController — options and tradeoffs (integration)', () => {
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

  async function registerWithSpace(label: string): Promise<{ cookie: string[] }> {
    const email = `decisions-opt-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    return { cookie: spaceCookie };
  }

  async function createDecision(cookie: string[], title = 'Decision'): Promise<string> {
    const res = await request(app.getHttpServer()).post('/decisions').set('Cookie', cookie).send({ title });
    return res.body.id as string;
  }

  it('creates an option under a decision', async () => {
    const { cookie } = await registerWithSpace('create-option');
    const decisionId = await createDecision(cookie);

    const res = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });

    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Austin');
    expect(res.body.score).toBe(0);
    expect(res.body.tradeOffs).toEqual([]);
  });

  it('updates an option label', async () => {
    const { cookie } = await registerWithSpace('update-option');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Original' });

    const res = await request(app.getHttpServer())
      .patch(`/decisions/${decisionId}/options/${optionRes.body.id}`)
      .set('Cookie', cookie)
      .send({ label: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Updated');
  });

  it('deletes an option', async () => {
    const { cookie } = await registerWithSpace('delete-option');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'To delete' });

    const deleteRes = await request(app.getHttpServer())
      .delete(`/decisions/${decisionId}/options/${optionRes.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const detailRes = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailRes.body.options).toEqual([]);
  });

  it('rejects a 7th option with 400 (MAX_OPTIONS_PER_DECISION = 6)', async () => {
    const { cookie } = await registerWithSpace('option-cap');
    const decisionId = await createDecision(cookie);

    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer())
        .post(`/decisions/${decisionId}/options`)
        .set('Cookie', cookie)
        .send({ label: `Option ${i}` });
      expect(res.status).toBe(201);
    }

    const seventh = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'One too many' });
    expect(seventh.status).toBe(400);
  });

  it('rejects an empty option label with 400', async () => {
    const { cookie } = await registerWithSpace('option-validation');
    const decisionId = await createDecision(cookie);

    const res = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: '' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when creating an option under a decision belonging to another space', async () => {
    const { cookie: cookieA } = await registerWithSpace('cross-space-option-a');
    const { cookie: cookieB } = await registerWithSpace('cross-space-option-b');
    const decisionId = await createDecision(cookieA);

    const res = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookieB)
      .send({ label: 'Sneaky' });
    expect(res.status).toBe(404);
  });

  it('creates, updates, and deletes a trade-off item, with score reflected in decision detail', async () => {
    const { cookie } = await registerWithSpace('tradeoff-crud');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    const optionId = optionRes.body.id as string;

    const proRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: 'Job market', weight: 5 });
    expect(proRes.status).toBe(201);

    const conRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'con', label: 'Far from family', weight: 3 });
    expect(conRes.status).toBe(201);

    const detailAfterCreate = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailAfterCreate.body.options[0].score).toBe(2); // 5 - 3

    const updateRes = await request(app.getHttpServer())
      .patch(`/decisions/${decisionId}/options/${optionId}/tradeoffs/${conRes.body.id}`)
      .set('Cookie', cookie)
      .send({ weight: 1 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.weight).toBe(1);

    const detailAfterUpdate = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailAfterUpdate.body.options[0].score).toBe(4); // 5 - 1

    const deleteRes = await request(app.getHttpServer())
      .delete(`/decisions/${decisionId}/options/${optionId}/tradeoffs/${conRes.body.id}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const detailAfterDelete = await request(app.getHttpServer()).get(`/decisions/${decisionId}`).set('Cookie', cookie);
    expect(detailAfterDelete.body.options[0].score).toBe(5); // pro only
  });

  it('rejects a 16th trade-off item with 400 (MAX_TRADEOFFS_PER_OPTION = 15)', async () => {
    const { cookie } = await registerWithSpace('tradeoff-cap');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    const optionId = optionRes.body.id as string;

    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer())
        .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
        .set('Cookie', cookie)
        .send({ type: 'pro', label: `Pro ${i}`, weight: 1 });
      expect(res.status).toBe(201);
    }

    const sixteenth = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: 'One too many', weight: 1 });
    expect(sixteenth.status).toBe(400);
  });

  it('rejects invalid trade-off payloads with 400', async () => {
    const { cookie } = await registerWithSpace('tradeoff-validation');
    const decisionId = await createDecision(cookie);
    const optionRes = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options`)
      .set('Cookie', cookie)
      .send({ label: 'Austin' });
    const optionId = optionRes.body.id as string;

    const badType = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'neutral', label: 'x', weight: 3 });
    expect(badType.status).toBe(400);

    const badWeight = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: 'x', weight: 6 });
    expect(badWeight.status).toBe(400);

    const emptyLabel = await request(app.getHttpServer())
      .post(`/decisions/${decisionId}/options/${optionId}/tradeoffs`)
      .set('Cookie', cookie)
      .send({ type: 'pro', label: '', weight: 3 });
    expect(emptyLabel.status).toBe(400);
  });
});
