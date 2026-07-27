import { Test } from '@nestjs/testing';
import { HealthStatusSchema } from '@us-os/shared-types';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('returns status ok with a valid ISO timestamp', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(HealthStatusSchema.safeParse(result).success).toBe(true);
  });
});
