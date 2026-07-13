const {
  signReceiptId,
  verifyReceiptSignature,
  isReceiptSigningEnforced,
} = require('../lib/receipt-signing');

const TXN_ID = '0b87e791-16e6-59ac-9392-ae87a86e1c2b';

describe('receipt signing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, RECEIPT_SIGNING_SECRET: 'test-secret-key' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('signs and verifies a transaction id', () => {
    const sig = signReceiptId(TXN_ID);
    expect(sig).toHaveLength(32);
    expect(verifyReceiptSignature(TXN_ID, sig)).toBe(true);
    expect(verifyReceiptSignature(TXN_ID, 'bad-signature')).toBe(false);
  });

  it('enforces signing in production when secret is set', () => {
    process.env.NODE_ENV = 'production';
    expect(isReceiptSigningEnforced()).toBe(true);
    delete process.env.RECEIPT_SIGNING_SECRET;
    delete process.env.CRON_SECRET;
    expect(isReceiptSigningEnforced()).toBe(false);
  });
});
