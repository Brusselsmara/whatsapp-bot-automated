jest.mock('../lib/db', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(),
  };
  return {
    supabase: {
      from: jest.fn(() => chain),
      rpc: jest.fn(),
      _chain: chain,
    },
  };
});

jest.mock('../lib/notifications', () => ({
  notifyUser: jest.fn().mockResolvedValue({ id: 'n1' }),
}));

jest.mock('../lib/settlement', () => ({
  claimReceiptSent: jest.fn().mockResolvedValue({ claimed: true }),
}));

const { supabase } = require('../lib/db');
const { notifyUser } = require('../lib/notifications');
const { claimReceiptSent } = require('../lib/settlement');
const { deliverSendReceipt } = require('../lib/receipt-delivery');

describe('receipt delivery', () => {
  const txnRow = {
    id: 'txn-1',
    type: 'send',
    status: 'completed',
    receipt_sent: false,
    phone: '+26771234567',
    recipient_name: 'Jane',
    payout_amount: 100,
    payout_currency: 'BWP',
    currency: 'BWP',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PUBLIC_APP_URL;
    supabase._chain.single.mockResolvedValue({ data: txnRow, error: null });
    supabase._chain.update.mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });
  });

  it('delivers a PWA notification with a relative receipt URL when PUBLIC_APP_URL is unset', async () => {
    const result = await deliverSendReceipt({ id: 'txn-1' });

    expect(result).toEqual({ sent: true });
    expect(claimReceiptSent).toHaveBeenCalledWith('txn-1');
    expect(notifyUser).toHaveBeenCalledWith(
      '+26771234567',
      expect.objectContaining({
        type: 'receipt',
        actionUrl: expect.stringMatching(/^\/api\/receipt\?id=txn-1/),
      })
    );
  });

  it('skips when transaction is not completed', async () => {
    supabase._chain.single.mockResolvedValue({
      data: { ...txnRow, status: 'pending' },
      error: null,
    });

    const result = await deliverSendReceipt({ id: 'txn-1' });
    expect(result).toEqual({ sent: false, reason: 'not_eligible' });
    expect(notifyUser).not.toHaveBeenCalled();
  });
});
