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

const { supabase } = require('../lib/db');
const {
  isPwaActivationKeyword,
  isCustomerServiceWindowOpen,
  PwaTwilioGateError,
  CSW_MS,
  buildPwaActivationHintForApp,
} = require('../lib/customer-service-window');

describe('customer-service-window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supabase.from.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      upsert: jest.fn().mockResolvedValue({ error: null }),
    }));
  });
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

  it('buildPwaActivationHintForApp tells unregistered users to activate on WhatsApp', async () => {
    const msg = await buildPwaActivationHintForApp('+26771234567', { kyc_status: 'unregistered' });
    expect(msg).toMatch(/activated from \*WhatsApp\*/i);
    expect(msg).toMatch(/reply \*app\*/i);
    expect(msg).not.toMatch(/PayLink app activated/i);
  });

  it('buildPwaActivationHintForApp tells registered users with expired CSW to refresh on WhatsApp', async () => {
    const stale = new Date(Date.now() - CSW_MS - 1000).toISOString();
    supabase.from.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          phone: '+26771234567',
          pwa_activated_at: stale,
          last_whatsapp_inbound_at: stale,
        },
      }),
    }));

    const msg = await buildPwaActivationHintForApp('+26771234567', { kyc_status: 'approved' });
    expect(msg).toMatch(/session has expired/i);
    expect(msg).toMatch(/reply \*app\*/i);
    expect(msg).not.toMatch(/PayLink app activated/i);
  });

  it('buildPwaActivationHintForApp tells active registered users they are already signed in', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    supabase.from.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          phone: '+26771234567',
          pwa_activated_at: recent,
          last_whatsapp_inbound_at: recent,
        },
      }),
    }));

    const msg = await buildPwaActivationHintForApp('+26771234567', { kyc_status: 'approved' });
    expect(msg).toMatch(/already signed in/i);
  });
});
