import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AuthModule } from './auth/auth.module';
import { DecisionsModule } from './decisions/decisions.module';
import { GoalsModule } from './goals/goals.module';
import { HealthController } from './health/health.controller';
import { MilestonesModule } from './milestones/milestones.module';
import { PromisesModule } from './promises/promises.module';
import { SessionModule } from './session/session.module';
import { SpacesModule } from './spaces/spaces.module';
import { TenantMiddleware } from './tenant/tenant.middleware';

@Module({
  imports: [SessionModule, AuthModule, SpacesModule, MilestonesModule, DecisionsModule, GoalsModule, PromisesModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('*');
    consumer.apply(TenantMiddleware).exclude('health').forRoutes('*');
  }
}
