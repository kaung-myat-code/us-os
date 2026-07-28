import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  it('maps the JWT payload to AuthenticatedUser', () => {
    const strategy = new JwtStrategy();
    const result = strategy.validate({ sub: 'user-1', spaceId: 'space-1' });
    expect(result).toEqual({ userId: 'user-1', spaceId: 'space-1' });
  });

  it('maps a null spaceId through unchanged', () => {
    const strategy = new JwtStrategy();
    const result = strategy.validate({ sub: 'user-1', spaceId: null });
    expect(result).toEqual({ userId: 'user-1', spaceId: null });
  });
});
