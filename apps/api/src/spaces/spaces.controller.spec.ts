import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SpacesModule } from './spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';

describe('SpacesController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SessionModule, AuthModule, SpacesModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerAndGetCookie(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `spaces-controller-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });
    return { cookie: res.headers['set-cookie'] as unknown as string[], email };
  }

  it('creates a Space for an authenticated user', async () => {
    const { cookie } = await registerAndGetCookie('create');

    const res = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', cookie)
      .send({ name: 'Our Space' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Our Space');
  });

  it('rejects creating a Space without a session cookie with 401', async () => {
    const res = await request(app.getHttpServer()).post('/spaces').send({ name: 'Our Space' });
    expect(res.status).toBe(401);
  });

  it('generates a pairing code for the caller\'s Space', async () => {
    const { cookie } = await registerAndGetCookie('gen');
    await request(app.getHttpServer()).post('/spaces').set('Cookie', cookie).send({ name: 'Gen Space' });

    const res = await request(app.getHttpServer()).post('/spaces/pairing-codes').set('Cookie', cookie).send({});

    expect(res.status).toBe(201);
    expect(res.body.code).toHaveLength(8);
  });

  it('redeems a pairing code end-to-end, and the joiner sees the creator as partner via /auth/me', async () => {
    const creator = await registerAndGetCookie('e2e-creator');
    await request(app.getHttpServer()).post('/spaces').set('Cookie', creator.cookie).send({ name: 'E2E Space' });
    const codeRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creator.cookie)
      .send({});

    const joiner = await registerAndGetCookie('e2e-joiner');
    const redeemRes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', joiner.cookie)
      .send({ code: codeRes.body.code });

    expect(redeemRes.status).toBe(201);
    const joinerCookie = redeemRes.headers['set-cookie'] as unknown as string[];

    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', joinerCookie);
    expect(meRes.body.space.partner.email).toBe(creator.email);
  });

  it('rejects redeeming an unknown code with 404', async () => {
    const { cookie } = await registerAndGetCookie('bad-code');
    const res = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', cookie)
      .send({ code: 'NOPECODE' });
    expect(res.status).toBe(404);
  });
});
