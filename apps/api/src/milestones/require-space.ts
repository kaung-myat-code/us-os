import { ConflictException } from '@nestjs/common';

export function requireSpaceId(spaceId: string | null): string {
  if (!spaceId) {
    throw new ConflictException('You must create or join a Space before using the timeline');
  }
  return spaceId;
}
