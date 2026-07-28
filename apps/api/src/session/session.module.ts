import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JWT_SECRET, SessionService } from './session.service';

// @Global() so TenantMiddleware (registered directly on AppModule, outside
// this module) can inject SessionService without every consuming module
// needing to import SessionModule explicitly.
@Global()
@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } })],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
