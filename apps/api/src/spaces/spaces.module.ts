import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';

@Module({
  imports: [AuthModule],
  controllers: [SpacesController],
  providers: [SpacesService],
})
export class SpacesModule {}
