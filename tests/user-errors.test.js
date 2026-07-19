const {
  stripPartnerBranding,
  isPartnerLeak,
  userFacingErrorMessage,
} = require('../lib/user-errors');

describe('user-errors', () => {
  it('detects partner branding in error text', () => {
    expect(isPartnerLeak('Yellow Card API error (400): bad')).toBe(true);
    expect(isPartnerLeak('PayLink is temporarily unavailable')).toBe(false);
  });

  it('userFacingErrorMessage hides partner errors', () => {
    const msg = userFacingErrorMessage(
      new Error('Yellow Card API error (400): {"code":"PaymentValidationError"}')
    );
    expect(msg).not.toMatch(/Yellow Card/i);
    expect(msg).toMatch(/try again/i);
  });

  it('stripPartnerBranding removes partner name', () => {
    expect(stripPartnerBranding('Failed: Yellow Card timeout')).toBe('Failed:');
  });
});
