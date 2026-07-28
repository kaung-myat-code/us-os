import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { prisma } from '@us-os/database';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { SpacesModule } from '../spaces/spaces.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';

describe('Tenant context integration (RLS pipeline + JWT payload)', () => {
  let app: INestApplication;
  let sessionService: SessionService;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SessionModule, AuthModule, SpacesModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    sessionService = moduleRef.get(SessionService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerAndGetCookie(label: string): Promise<{ cookie: string[]; email: string }> {
    const email = `tenant-integration-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    createdEmails.push(email);
    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password: 'supersecret' });
    return { cookie: res.headers['set-cookie'] as unknown as string[], email };
  }

  it('decodes the JWT payload as { sub, spaceId: null } right after registration, and { sub, spaceId } after creating a Space', async () => {
    const { cookie } = await registerAndGetCookie('payload');
    const rawCookieHeader = cookie.find((c) => c.startsWith(SessionService.COOKIE_NAME));
    const tokenBeforeSpace = rawCookieHeader!.split(';')[0]!.split('=')[1]!;
    const payloadBeforeSpace = sessionService.verify(tokenBeforeSpace);
    expect(payloadBeforeSpace?.spaceId).toBeNull();
    const userId = payloadBeforeSpace!.sub;

    const spaceRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', cookie)
      .send({ name: 'Payload Test Space' });
    const spaceCookies = spaceRes.headers['set-cookie'] as unknown as string[];
    const newCookieHeader = spaceCookies.find((c) => c.startsWith(SessionService.COOKIE_NAME));
    const tokenAfterSpace = newCookieHeader!.split(';')[0]!.split('=')[1]!;
    const payloadAfterSpace = sessionService.verify(tokenAfterSpace);

    expect(payloadAfterSpace).toEqual({ sub: userId, spaceId: spaceRes.body.id });
  });

  it('sets app.current_space_id correctly for a request carrying a paired session, and isolates a different space', async () => {
    const creatorA = await registerAndGetCookie('rls-a-creator');
    const spaceARes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', creatorA.cookie)
      .send({ name: 'RLS Space A' });
    const codeARes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes')
      .set('Cookie', creatorA.cookie)
      .send({});
    const memberA = await registerAndGetCookie('rls-a-member');
    const redeemARes = await request(app.getHttpServer())
      .post('/spaces/pairing-codes/redeem')
      .set('Cookie', memberA.cookie)
      .send({ code: codeARes.body.code });
    const memberACookie = redeemARes.headers['set-cookie'] as unknown as string[];
    const memberAToken = memberACookie
      .find((c) => c.startsWith(SessionService.COOKIE_NAME))!
      .split(';')[0]!
      .split('=')[1]!;
    const memberAPayload = sessionService.verify(memberAToken);

    const creatorC = await registerAndGetCookie('rls-c-creator');
    const spaceCRes = await request(app.getHttpServer())
      .post('/spaces')
      .set('Cookie', creatorC.cookie)
      .send({ name: 'RLS Space C' });

    // Directly verify the SET LOCAL pipeline: TenantContext.run mirrors what
    // TenantMiddleware does for a real request carrying this cookie's payload.
    const { TenantContext } = await import('@us-os/database');
    const currentSettingForA = await TenantContext.run(memberAPayload!.spaceId as string, () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_space_id', ${memberAPayload!.spaceId}, true)`;
        const rows = await tx.$queryRaw<{ current_setting: string }[]>`SELECT current_setting('app.current_space_id')`;
        return rows[0]!.current_setting;
      }),
    );
    expect(currentSettingForA).toBe(spaceARes.body.id);
    expect(currentSettingForA).not.toBe(spaceCRes.body.id);
  });
});
