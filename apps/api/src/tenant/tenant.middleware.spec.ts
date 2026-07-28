import { TenantContext } from '@us-os/database';
import { TenantMiddleware } from './tenant.middleware';

describe('TenantMiddleware', () => {
  let middleware: TenantMiddleware;

  beforeEach(() => {
    middleware = new TenantMiddleware();
  });

  it('runs next() inside a TenantContext populated from the x-space-id header', () => {
    const req = { header: (name: string) => (name === 'x-space-id' ? 'space-123' : undefined) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    let spaceIdSeenInsideNext: string | undefined;

    middleware.use(req as never, res as never, () => {
      spaceIdSeenInsideNext = TenantContext.currentSpaceId;
    });

    expect(spaceIdSeenInsideNext).toBe('space-123');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 400 with RFC 7807 Problem Details when x-space-id is missing', () => {
    const req = { header: () => undefined };
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }), json };
    const next = jest.fn();

    middleware.use(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Missing tenant context',
      status: 400,
      detail: 'x-space-id header is required',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
