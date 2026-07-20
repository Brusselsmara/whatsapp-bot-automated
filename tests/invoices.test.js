jest.mock('../lib/db', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };
  return {
    supabase: {
      from: jest.fn(() => chain),
      _chain: chain,
    },
  };
});

const { supabase } = require('../lib/db');
const {
  normalizeInvoiceCode,
  buildInvoicePaymentUrl,
  getPublicInvoice,
} = require('../lib/invoices');

describe('invoices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PUBLIC_APP_URL = 'https://paylink.example.com';
  });

  it('normalizes invoice codes', () => {
    expect(normalizeInvoiceCode(' inv-abc123 ')).toBe('INV-ABC123');
    expect(normalizeInvoiceCode('bad')).toBeNull();
  });

  it('builds payment URLs', () => {
    expect(buildInvoicePaymentUrl('INV-ABC123')).toBe(
      'https://paylink.example.com/pay/INV-ABC123'
    );
  });

  it('returns public invoice preview without issuer phone', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({
        data: {
          invoice_code: 'INV-TEST1',
          amount: 1500,
          currency: 'BWP',
          country: 'BW',
          description: 'Consulting',
          status: 'pending',
          issuer_phone: '+26771234567',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { kyc_name: 'Jane', business_name: 'Acme Ltd' },
        error: null,
      });

    const preview = await getPublicInvoice('INV-TEST1');
    expect(preview).toMatchObject({
      code: 'INV-TEST1',
      amount: 1500,
      currency: 'BWP',
      merchantName: 'Acme Ltd',
      payable: true,
    });
    expect(preview.paymentUrl).toContain('/pay/INV-TEST1');
    expect(JSON.stringify(preview)).not.toContain('+267');
  });
});
