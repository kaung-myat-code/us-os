import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [GoalsController],
  providers: [GoalsService],
})
export class GoalsModule {}
