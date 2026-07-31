import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PromisesController } from './promises.controller';
import { PromisesService } from './promises.service';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [PromisesController],
  providers: [PromisesService],
})
export class PromisesModule {}
