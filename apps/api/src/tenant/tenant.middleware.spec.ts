import { JwtService } from '@nestjs/jwt';
import { TenantContext } from '@us-os/database';
import { JWT_SECRET, SessionService } from '../session/session.service';
import { TenantMiddleware } from './tenant.middleware';

describe('TenantMiddleware', () => {
  let middleware: TenantMiddleware;
  let sessionService: SessionService;

  beforeEach(() => {
    sessionService = new SessionService(new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } }));
    middleware = new TenantMiddleware(sessionService);
  });

  it('runs next() inside a TenantContext when the session cookie carries a spaceId', () => {
    const token = (sessionService as unknown as { jwtService: JwtService }).jwtService.sign({
      sub: 'user-1',
      spaceId: 'space-123',
    });
    const req = { cookies: { [SessionService.COOKIE_NAME]: token } };
    let spaceIdSeenInsideNext: string | undefined;

    middleware.use(req as never, {} as never, () => {
      spaceIdSeenInsideNext = TenantContext.currentSpaceId;
    });

    expect(spaceIdSeenInsideNext).toBe('space-123');
  });

  it('calls next() without a TenantContext when there is no session cookie', () => {
    const req = { cookies: {} };
    let sawContext = true;

    middleware.use(req as never, {} as never, () => {
      sawContext = TenantContext.currentSpaceId !== undefined;
    });

    expect(sawContext).toBe(false);
  });

  it('calls next() without a TenantContext when the session cookie has spaceId: null', () => {
    const token = (sessionService as unknown as { jwtService: JwtService }).jwtService.sign({
      sub: 'user-1',
      spaceId: null,
    });
    const req = { cookies: { [SessionService.COOKIE_NAME]: token } };
    let sawContext = true;

    middleware.use(req as never, {} as never, () => {
      sawContext = TenantContext.currentSpaceId !== undefined;
    });

    expect(sawContext).toBe(false);
  });

  it('calls next() without a TenantContext when the cookie is invalid', () => {
    const req = { cookies: { [SessionService.COOKIE_NAME]: 'garbage' } };
    let sawContext = true;

    middleware.use(req as never, {} as never, () => {
      sawContext = TenantContext.currentSpaceId !== undefined;
    });

    expect(sawContext).toBe(false);
  });
});
