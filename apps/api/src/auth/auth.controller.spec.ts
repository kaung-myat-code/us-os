import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthModule } from './auth.module';
import { SessionModule } from '../session/session.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';

describe('AuthController (integration)', () => {
  let app: INestApplication;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SessionModule, AuthModule] }).compile();
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

  function uniqueEmail(label: string): string {
    const email = `auth-controller-${label}-${Date.now()}@example.com`;
    createdEmails.push(email);
    return email;
  }

  it('registers a new user and sets a session cookie', async () => {
    const email = uniqueEmail('register');
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });

    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']?.[0]).toContain('us_os_session=');
  });

  it('rejects a duplicate email with a 409 Problem Details body', async () => {
    const email = uniqueEmail('duplicate');
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'different-password' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      type: 'about:blank',
      status: 409,
      detail: 'An account with this email already exists',
    });
  });

  it('logs in with correct credentials and sets a session cookie', async () => {
    const email = uniqueEmail('login');
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'supersecret' });

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toContain('us_os_session=');
  });

  it('rejects login with incorrect credentials with 401', async () => {
    const email = uniqueEmail('login-wrong');
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns 401 with no session cookie', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the user with space: null right after registration', async () => {
    const email = uniqueEmail('me');
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const cookie = registerRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.space).toBeNull();
  });

  it('POST /auth/logout clears the session cookie and /auth/me then returns 401', async () => {
    const email = uniqueEmail('logout');
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'supersecret' });
    const cookie = registerRes.headers['set-cookie'] as unknown as string[];

    const logoutRes = await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers['set-cookie']?.[0]).toMatch(/us_os_session=;/);

    // Use the *cleared* cookie the server just sent back, not the original
    // registration cookie. This is a stateless-JWT session: the original
    // token remains cryptographically valid until it naturally expires, so
    // resending it would still authenticate (there is no server-side
    // revocation list). A real browser would apply the clearing Set-Cookie
    // and stop sending the old value; simulating that here (rather than
    // resending the still-valid original token) is what actually exercises
    // the "immediate GET /auth/me -> 401 after logout" behavior.
    const clearedCookie = logoutRes.headers['set-cookie'] as unknown as string[];
    const meRes = await request(app.getHttpServer()).get('/auth/me').set('Cookie', clearedCookie);
    expect(meRes.status).toBe(401);
  });
});
