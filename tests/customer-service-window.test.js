jest.mock('../lib/db', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      upsert: jest.fn().mockResolvedValue({ error: null }),
    })),
  },
}));

const {
  isPwaActivationKeyword,
  isCustomerServiceWindowOpen,
  PwaTwilioGateError,
  CSW_MS,
} = require('../lib/customer-service-window');

describe('customer-service-window', () => {
  it('recognizes PWA activation keywords', () => {
    expect(isPwaActivationKeyword('app')).toBe(true);
    expect(isPwaActivationKeyword('APP')).toBe(true);
    expect(isPwaActivationKeyword('activate')).toBe(true);
    expect(isPwaActivationKeyword('menu')).toBe(false);
  });

  it('opens CSW for 24 hours after last inbound', () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = new Date(Date.now() - CSW_MS - 1000).toISOString();
    expect(isCustomerServiceWindowOpen(recent)).toBe(true);
    expect(isCustomerServiceWindowOpen(stale)).toBe(false);
    expect(isCustomerServiceWindowOpen(null)).toBe(false);
  });

  it('exposes gate error codes', () => {
    const err = new PwaTwilioGateError('PWA_NOT_ACTIVATED', 'activate first');
    expect(err.code).toBe('PWA_NOT_ACTIVATED');
  });
});
