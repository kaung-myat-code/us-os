import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface EncryptedNote {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function loadMasterKey(): Buffer {
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw || !BASE64_PATTERN.test(raw)) {
    throw new Error('ENCRYPTION_MASTER_KEY must be a valid base64 string');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  }
  return key;
}

// Loaded once at module import time (same fail-fast-at-boot pattern as
// JWT_SECRET in session.service.ts) so a bad key surfaces immediately on
// startup, never on the first note write.
const MASTER_KEY = loadMasterKey();

@Injectable()
export class CryptoService {
  encryptNote(plaintext: string): EncryptedNote {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decryptNote({ ciphertext, iv, authTag }: EncryptedNote): string {
    const decipher = createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
