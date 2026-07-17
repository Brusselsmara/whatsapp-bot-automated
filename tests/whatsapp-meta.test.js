const {
  handleVerifyChallenge,
  verifyWebhookSignature,
  parseInboundWebhook,
  normalizePhone,
} = require('../lib/whatsapp-meta');

describe('whatsapp-meta', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('handles Meta webhook verify challenge', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'my-verify-token';
    const challenge = handleVerifyChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-verify-token',
      'hub.challenge': '1234567890',
    });
    expect(challenge).toBe('1234567890');
    expect(handleVerifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong' })).toBeNull();
  });

  it('verifies webhook signature', () => {
    process.env.WHATSAPP_APP_SECRET = 'test-secret';
    const body = '{"object":"whatsapp_business_account"}';
    const crypto = require('crypto');
    const sig = `sha256=${crypto.createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    expect(verifyWebhookSignature(body, sig)).toBe(true);
    expect(verifyWebhookSignature(body, 'sha256=bad')).toBe(false);
  });

  it('parses inbound text and media messages', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            messages: [
              {
                id: 'wamid.abc',
                from: '26771234567',
                type: 'text',
                text: { body: 'menu' },
              },
              {
                id: 'wamid.def',
                from: '26771234567',
                type: 'image',
                image: { id: 'media123', caption: 'ID scan' },
              },
            ],
          },
        }],
      }],
    };

    const parsed = parseInboundWebhook(payload);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].phone).toBe('+26771234567');
    expect(parsed[0].text).toBe('menu');
    expect(parsed[1].mediaRefs).toEqual(['meta:media123']);
    expect(parsed[1].text).toBe('ID scan');
  });

  it('normalizePhone strips whatsapp prefix', () => {
    expect(normalizePhone('whatsapp:+26771234567')).toBe('+26771234567');
    expect(normalizePhone('26771234567')).toBe('+26771234567');
  });
});
