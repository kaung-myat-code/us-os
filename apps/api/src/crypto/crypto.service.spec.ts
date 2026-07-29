const VALID_KEY = 'VtSyCyvXNXUu44OK/8QX9nCFx5qyOhf1va3ipjNrYbs=';

describe('CryptoService', () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
    jest.resetModules();
  });

  afterAll(() => {
    process.env.ENCRYPTION_MASTER_KEY = originalKey;
  });

  it('round-trips a plaintext note', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-imports the module fresh per test so MASTER_KEY re-evaluates against the env var set in beforeEach
    const { CryptoService } = require('./crypto.service');
    const service = new CryptoService();
    const encrypted = service.encryptNote('We moved in together');
    expect(service.decryptNote(encrypted)).toBe('We moved in together');
  });

  it('produces a different iv and ciphertext on each call for the same plaintext', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-imports the module fresh per test so MASTER_KEY re-evaluates against the env var set in beforeEach
    const { CryptoService } = require('./crypto.service');
    const service = new CryptoService();
    const first = service.encryptNote('same text');
    const second = service.encryptNote('same text');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('throws when decrypting with a tampered auth tag', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-imports the module fresh per test so MASTER_KEY re-evaluates against the env var set in beforeEach
    const { CryptoService } = require('./crypto.service');
    const service = new CryptoService();
    const encrypted = service.encryptNote('sensitive');
    const tampered = { ...encrypted, authTag: Buffer.from('0'.repeat(16)).toString('base64') };
    expect(() => service.decryptNote(tampered)).toThrow();
  });

  it('refuses to load when ENCRYPTION_MASTER_KEY is missing', () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- module-load-time throw only observable via a fresh require() with the env var unset
    expect(() => require('./crypto.service')).toThrow('ENCRYPTION_MASTER_KEY must be a valid base64 string');
  });

  it('refuses to load when ENCRYPTION_MASTER_KEY does not decode to exactly 32 bytes', () => {
    process.env.ENCRYPTION_MASTER_KEY = Buffer.from('too short').toString('base64');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- module-load-time throw only observable via a fresh require() with the invalid env var set
    expect(() => require('./crypto.service')).toThrow('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  });
});
