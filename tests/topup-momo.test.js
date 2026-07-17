const {
  topupMomoNumberPrompt,
  isUseWhatsappShortcut,
  formatWhatsappMomoConfirm,
  isAffirmative,
  isNegative,
  formatNetworkPickerPrompt,
  parseNetworkChoice,
  formatReceiveExpiryMins,
  formatMomoTopupSuccessMessage,
} = require('../lib/topup-momo');

describe('topup-momo helpers', () => {
  test('topupMomoNumberPrompt mentions USSD target and WhatsApp shortcut', () => {
    const prompt = topupMomoNumberPrompt({
      country: 'BW',
      currency: 'BWP',
      whatsappPhone: 'whatsapp:+26777123456',
    });
    expect(prompt).toMatch(/not necessarily this WhatsApp chat/i);
    expect(prompt).toMatch(/Reply \*1\*/);
    expect(prompt).toMatch(/\+26777123456/);
  });

  test('isUseWhatsappShortcut only matches "1"', () => {
    expect(isUseWhatsappShortcut('1')).toBe(true);
    expect(isUseWhatsappShortcut(' 1 ')).toBe(true);
    expect(isUseWhatsappShortcut('2')).toBe(false);
    expect(isUseWhatsappShortcut('+26777123456')).toBe(false);
  });

  test('formatWhatsappMomoConfirm shows momo number', () => {
    expect(formatWhatsappMomoConfirm('+26777123456')).toMatch(/\+26777123456/);
  });

  test('affirmative / negative shortcuts', () => {
    expect(isAffirmative('yes')).toBe(true);
    expect(isAffirmative('confirm')).toBe(true);
    expect(isNegative('no')).toBe(true);
    expect(isNegative('cancel')).toBe(true);
  });

  test('network picker lists providers and parses choice', () => {
    const networks = [{ id: 'n1', name: 'Orange Money' }, { id: 'n2', name: 'MyZaka' }];
    const prompt = formatNetworkPickerPrompt(networks);
    expect(prompt).toMatch(/1️⃣ Orange Money/);
    expect(prompt).toMatch(/2️⃣ MyZaka/);
    expect(parseNetworkChoice('2', networks)).toEqual(networks[1]);
    expect(parseNetworkChoice('9', networks)).toBeNull();
  });

  test('formatReceiveExpiryMins rounds up', () => {
    const inFiveMins = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(formatReceiveExpiryMins(inFiveMins)).toBe(5);
    expect(formatReceiveExpiryMins(null)).toBeNull();
  });

  test('formatMomoTopupSuccessMessage includes momo number and expiry', () => {
    const inTenMins = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const msg = formatMomoTopupSuccessMessage({
      amount: 100,
      currency: 'BWP',
      topupFee: 5,
      netCredit: 95,
      reference: 'REF-123',
      momoNumber: '+26777123456',
      expiresAt: inTenMins,
      sandbox: false,
    });
    expect(msg).toMatch(/\+26777123456/);
    expect(msg).toMatch(/within ~10 minutes/);
    expect(msg).toMatch(/REF-123/);
  });
});
