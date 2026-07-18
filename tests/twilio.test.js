const twilio = require('twilio');

describe('twilio adapter', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.restoreAllMocks();
  });

  it('reports configured when env vars are set', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    jest.resetModules();
    const { isTwilioWhatsAppConfigured } = require('../lib/twilio');
    expect(isTwilioWhatsAppConfigured()).toBe(true);
  });

  it('validates Twilio webhook signatures', () => {
    process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
    const params = { From: 'whatsapp:+26771234567', Body: 'menu' };
    const url = 'https://example.vercel.app/api/whatsapp';
    const signature = twilio.getExpectedTwilioSignature('test-auth-token', url, params);
    expect(twilio.validateRequest('test-auth-token', signature, url, params)).toBe(true);
    expect(twilio.validateRequest('test-auth-token', 'bad', url, params)).toBe(false);
  });
});
