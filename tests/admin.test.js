const {
  signSession,
  verifySessionToken,
  verifyLoginPassword,
} = require('../lib/admin-auth');
const { computeTxnProfit, buildDashboardFromData } = require('../lib/admin-metrics');
const { parseDateFilters, isTxnInRange } = require('../lib/admin-filters');
const { buildTransactionsCsv } = require('../lib/admin-csv');

describe('admin-auth', () => {
  const original = process.env.ADMIN_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = original;
  });

  it('signs and verifies session tokens', () => {
    process.env.ADMIN_SECRET = 'test-admin-secret-32chars-long!!';
    const exp = Date.now() + 60000;
    const token = signSession(exp);
    expect(verifySessionToken(token)).toBe(true);
    expect(verifySessionToken('bad.token')).toBe(false);
  });

  it('verifyLoginPassword matches ADMIN_SECRET', () => {
    process.env.ADMIN_SECRET = 'my-secret-password';
    expect(verifyLoginPassword('my-secret-password')).toBe(true);
    expect(verifyLoginPassword('wrong')).toBe(false);
  });
});

describe('admin-metrics', () => {
  it('computes top-up profit as markup only', () => {
    const profit = computeTxnProfit({
      type: 'topup',
      status: 'completed',
      amount: 100,
      yc_fee_amount: 5,
      markup_amount: 12,
    });
    expect(profit.paylinkProfit).toBe(12);
    expect(profit.fxMargin).toBe(0);
  });

  it('computes domestic send profit as markup', () => {
    const profit = computeTxnProfit({
      type: 'send',
      status: 'completed',
      amount: 200,
      currency: 'BWP',
      payout_currency: 'BWP',
      yc_fee_amount: 8,
      markup_amount: 15,
    });
    expect(profit.paylinkProfit).toBe(15);
  });

  it('builds dashboard aggregates by currency', () => {
    const data = buildDashboardFromData({
      users: [{ phone: '+2671', kyc_status: 'approved' }],
      transactions: [
        {
          phone: '+2671',
          type: 'topup',
          status: 'completed',
          amount: 100,
          currency: 'BWP',
          recipient_channel_type: 'momo',
          yc_fee_amount: 5,
          markup_amount: 10,
        },
        {
          phone: '+2671',
          type: 'send',
          status: 'completed',
          amount: 50,
          currency: 'BWP',
          payout_amount: 50,
          payout_currency: 'BWP',
          recipient_channel_type: 'bank',
          yc_fee_amount: 2,
          markup_amount: 5,
        },
      ],
      wallets: [{ phone: '+2671', currency: 'BWP', balance: 35 }],
    });

    expect(data.byCurrency.BWP.moneyIn.gross).toBe(100);
    expect(data.byCurrency.BWP.moneyIn.momo).toBe(100);
    expect(data.byCurrency.BWP.moneyOut.gross).toBe(50);
    expect(data.byCurrency.BWP.moneyOut.bank).toBe(50);
    expect(data.byCurrency.BWP.profit.total).toBe(15);
    expect(data.byCurrency.BWP.balance.topupPoolAfterProfit).toBe(90);
    expect(data.byCurrency.BWP.balance.userWalletLiabilities).toBe(35);
    expect(data.byCurrency.BWP.balance.impliedFloat).toBe(40);
  });

  it('filters transactions by date range', () => {
    const filters = parseDateFilters({ from: '2026-01-01', to: '2026-01-31' });
    expect(filters.error).toBeUndefined();

    const data = buildDashboardFromData({
      users: [{ phone: '+2671', kyc_status: 'approved' }],
      transactions: [
        {
          phone: '+2671',
          type: 'topup',
          status: 'completed',
          amount: 100,
          currency: 'BWP',
          created_at: '2026-01-15T10:00:00.000Z',
          recipient_channel_type: 'momo',
          yc_fee_amount: 0,
          markup_amount: 10,
        },
        {
          phone: '+2671',
          type: 'topup',
          status: 'completed',
          amount: 200,
          currency: 'BWP',
          created_at: '2026-02-01T10:00:00.000Z',
          recipient_channel_type: 'momo',
          yc_fee_amount: 0,
          markup_amount: 10,
        },
      ],
      wallets: [],
      filters,
    });

    expect(data.totals.filteredTransactions).toBe(1);
    expect(data.byCurrency.BWP.moneyIn.gross).toBe(100);
    expect(isTxnInRange({ created_at: '2026-02-01T10:00:00.000Z' }, filters)).toBe(false);
  });

  it('builds CSV export rows', () => {
    const csv = buildTransactionsCsv([
      {
        createdAt: '2026-01-15T10:00:00.000Z',
        typeLabel: 'Top-up',
        userName: 'Test User',
        phone: '+2671',
        channel: 'Momo (Mobile Money)',
        amount: 100,
        currency: 'BWP',
        payoutAmount: null,
        payoutCurrency: 'BWP',
        profit: { paylinkProfit: 10, markup: 10, fxMargin: 0, ycFee: 5 },
        reference: 'REF123',
      },
    ]);
    expect(csv).toMatch(/Top-up/);
    expect(csv).toMatch(/Test User/);
    expect(csv).toMatch(/REF123/);
  });

  it('rejects invalid date ranges', () => {
    const filters = parseDateFilters({ from: '2026-02-01', to: '2026-01-01' });
    expect(filters.error).toBeTruthy();
  });
});
