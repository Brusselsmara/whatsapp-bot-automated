const { computeInvoiceCustomerFeesFromTxn } = require('../lib/quotes');
const { divideByRate, subMoney } = require('../lib/money');

describe('computeInvoiceCustomerFeesFromTxn', () => {
  it('returns service fees only for same-currency invoice', () => {
    const fees = computeInvoiceCustomerFeesFromTxn({
      type: 'invoice_payment',
      payout_amount: 1000,
      amount: 1050,
      currency: 'BWP',
      payout_currency: 'BWP',
      yc_fee_amount: 30,
      markup_amount: 20,
    });
    expect(fees).toBe(50);
  });

  it('reconstructs all-in wallet fees for cross-currency invoice (100k ZAR receipt)', () => {
    const displayRate = 1.2155;
    const marginPct = 0.02;
    const walletDebit = 82939.19;
    const face = 100000;

    const fees = computeInvoiceCustomerFeesFromTxn({
      type: 'invoice_payment',
      payout_amount: face,
      amount: walletDebit,
      currency: 'BWP',
      payout_currency: 'ZAR',
      display_rate: displayRate,
      margin_pct: marginPct,
      yc_fee_amount: 500,
      markup_amount: 310.78,
    });

    const bridgedRate = displayRate / (1 - marginPct);
    const expected = subMoney(walletDebit, divideByRate(face, bridgedRate));
    expect(fees).toBe(expected);
    expect(fees).toBeGreaterThan(2300);
    expect(fees).toBeLessThan(2320);
  });
});
