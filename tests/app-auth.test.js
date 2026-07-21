jest.mock('../lib/whatsapp', () => ({
  sendWhatsApp: jest.fn().mockResolvedValue({ sid: 'SM123' }),
}));

jest.mock('../lib/customer-service-window', () => ({
  assertPwaTwilioAllowed: jest.fn().mockResolvedValue({ canSendPwaOtp: true }),
}));

const { sendWhatsApp } = require('../lib/whatsapp');
const {
  isAppAuthConfigured,
  issueOtp,
  verifyOtpToken,
  createAppSessionCookie,
  getPhoneFromSession,
} = require('../lib/app-auth');

describe('app-auth', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.APP_SESSION_SECRET = 'test-app-secret';
    sendWhatsApp.mockClear();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('requires APP_SESSION_SECRET', () => {
    delete process.env.APP_SESSION_SECRET;
    delete process.env.CRON_SECRET;
    jest.resetModules();
    const mod = require('../lib/app-auth');
    expect(mod.isAppAuthConfigured()).toBe(false);
  });

  it('issues and verifies OTP tokens', async () => {
    expect(isAppAuthConfigured()).toBe(true);
    const { otpToken, devCode } = await issueOtp('+26771234567');
    expect(otpToken).toContain('+26771234567');
    expect(devCode).toMatch(/^\d{6}$/);
    expect(sendWhatsApp).toHaveBeenCalled();
    expect(verifyOtpToken('+26771234567', devCode, otpToken)).toBe(true);
    expect(verifyOtpToken('+26771234567', '000000', otpToken)).toBe(false);
  });

  it('creates and reads session cookies', () => {
    const cookie = createAppSessionCookie('+26771234567');
    expect(cookie).toContain('romela_pula_app=');
    const token = decodeURIComponent(cookie.split('=')[1].split(';')[0]);
    const req = { headers: { cookie: `romela_pula_app=${encodeURIComponent(token)}` } };
    expect(getPhoneFromSession(req)).toBe('+26771234567');
  });
});
