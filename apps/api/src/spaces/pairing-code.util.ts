// apps/api/src/spaces/pairing-code.util.ts
import { randomInt } from 'node:crypto';

const PAIRING_CODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PAIRING_CODE_LENGTH = 8;

export function generatePairingCodeString(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_CHARSET[randomInt(PAIRING_CODE_CHARSET.length)];
  }
  return code;
}
