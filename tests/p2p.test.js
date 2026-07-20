jest.mock('../lib/db', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
  },
}));

const { supabase } = require('../lib/db');
const { executeP2PTransfer, findPaylinkRecipient } = require('../lib/p2p');

describe('p2p', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('findPaylinkRecipient returns approved users only', async () => {
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          phone: '+26771111111',
          kyc_status: 'approved',
          kyc_name: 'Bob',
          home_currency: 'BWP',
        },
        error: null,
      }),
    });

    const user = await findPaylinkRecipient('+26771111111');
    expect(user.phone).toBe('+26771111111');
  });

  it('executeP2PTransfer maps RPC failures to messages', async () => {
    supabase.rpc.mockResolvedValue({
      data: [{ claimed: false, reason: 'insufficient_funds' }],
      error: null,
    });

    const result = await executeP2PTransfer({
      senderPhone: '+26771234567',
      recipientPhone: '+26771111111',
      amount: 100,
      currency: 'BWP',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Insufficient balance/i);
  });

  it('executeP2PTransfer returns balances on success', async () => {
    supabase.rpc.mockResolvedValue({
      data: [{
        claimed: true,
        txn_id: 'txn-1',
        sender_balance: 400,
        recipient_balance: 600,
      }],
      error: null,
    });

    const result = await executeP2PTransfer({
      senderPhone: '+26771234567',
      recipientPhone: '+26771111111',
      amount: 100,
      currency: 'BWP',
    });

    expect(result).toEqual({
      ok: true,
      txnId: 'txn-1',
      senderBalance: 400,
      recipientBalance: 600,
    });
  });
});
