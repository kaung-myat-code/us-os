import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LocalStrategy } from './local.strategy';

describe('LocalStrategy', () => {
  it('returns { userId } when AuthService.validateUser resolves', async () => {
    const authService = { validateUser: jest.fn().mockResolvedValue({ userId: 'user-1' }) } as unknown as AuthService;
    const strategy = new LocalStrategy(authService);

    const result = await strategy.validate('a@example.com', 'password123');

    expect(authService.validateUser).toHaveBeenCalledWith('a@example.com', 'password123');
    expect(result).toEqual({ userId: 'user-1', spaceId: null });
  });

  it('propagates UnauthorizedException from AuthService.validateUser', async () => {
    const authService = {
      validateUser: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid email or password')),
    } as unknown as AuthService;
    const strategy = new LocalStrategy(authService);

    await expect(strategy.validate('a@example.com', 'wrong')).rejects.toThrow('Invalid email or password');
  });
});
