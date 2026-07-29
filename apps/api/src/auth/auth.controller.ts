import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { LoginRequestSchema, RegisterRequestSchema, type LoginRequest, type RegisterRequest } from '@us-os/shared-types';
import type { Request, Response } from 'express';
import { createZodValidationPipe } from '../common/zod-validation.pipe';
import { SessionService } from '../session/session.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LocalAuthGuard } from './local-auth.guard';
import type { AuthenticatedUser } from './types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  @Post('register')
  @UsePipes(createZodValidationPipe(RegisterRequestSchema))
  async register(@Body() dto: RegisterRequest, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.register(dto);
    await this.sessionService.issueSessionCookie(res, user.id);
    return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(200)
  @UsePipes(createZodValidationPipe(LoginRequestSchema))
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- @Body() binding is required so the Zod pipe validates the raw payload before LocalStrategy reads req.body directly
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() _dto: LoginRequest) {
    const { userId } = req.user as AuthenticatedUser;
    await this.sessionService.issueSessionCookie(res, userId);
    return this.authService.getMe(userId);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    this.sessionService.clearSessionCookie(res);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: Request) {
    const { userId } = req.user as AuthenticatedUser;
    return this.authService.getMe(userId);
  }
}
