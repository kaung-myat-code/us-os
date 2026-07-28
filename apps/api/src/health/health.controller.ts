import { Controller, Get } from '@nestjs/common';
import type { HealthStatus } from '@us-os/shared-types';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
