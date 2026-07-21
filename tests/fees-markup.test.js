jest.mock('../lib/yellowcard', () => ({
  getRateForCurrency: jest.fn(),
  getFeeConfig: jest.fn(),
}));

const yc = require('../lib/yellowcard');
const { mockGetRateForCurrency } = require('./helpers/mock-rates');
const {
  buildRomelaPulaServiceMarkup,
  buildRomelaPulaTopupMarkup,
  buildInvoicePaymentQuote,
} = require('../lib/fees');

beforeEach(() => {
  yc.getRateForCurrency.mockImplementation(mockGetRateForCurrency);
});

describe('buildRomelaPulaServiceMarkup', () => {
  it('charges flat BWP tier + 0.5× YC fee in BWP', async () => {
    const result = await buildRomelaPulaServiceMarkup({
      tierBasisAmount: 1000,
      tierBasisCurrency: 'BWP',
      feeCurrency: 'BWP',
      ycFeeAmount: 10,
    });

    expect(result.flatBwp).toBe(15);
    expect(result.flatFee).toBe(15);
    expect(result.ycFeeMarkup).toBe(5);
    expect(result.markupAmount).toBe(20);
    expect(result.customerFeeTotal).toBe(30);
  });

  it('converts flat tier from BWP to ZAR using USD bridge', async () => {
    const result = await buildRomelaPulaServiceMarkup({
      tierBasisAmount: 100000,
      tierBasisCurrency: 'ZAR',
      feeCurrency: 'ZAR',
      ycFeeAmount: 500,
    });

    // 100k ZAR ≈ 137k BWP equivalent at mock rates → 100001–500000 tier
    expect(result.flatBwp).toBe(100);
    expect(result.ycFeeMarkup).toBe(250);
    expect(result.markupAmount).toBeGreaterThan(250);
    expect(result.customerFeeTotal).toBe(500 + result.markupAmount);
  });
});

describe('buildRomelaPulaTopupMarkup', () => {
  it('charges BWP 10 flat + 0.2× YC collection fee', async () => {
    const result = await buildRomelaPulaTopupMarkup({
      feeCurrency: 'BWP',
      ycFeeAmount: 90,
    });

    expect(result.flatBwp).toBe(10);
    expect(result.flatFee).toBe(10);
    expect(result.ycFeeMarkup).toBe(18);
    expect(result.markupAmount).toBe(28);
    expect(result.totalFee).toBe(118);
  });
});

describe('buildInvoicePaymentQuote', () => {
  beforeEach(() => {
    yc.getFeeConfig.mockResolvedValue({
      serviceFee: { flatFeeLocal: 0, minFeeLocal: 0, feePercentage: 0.5 },
    });
  });

  it('returns face + YC fee + markup as totalCharge', async () => {
    const quote = await buildInvoicePaymentQuote({
      payoutAmount: 100000,
      currency: 'ZAR',
      country: 'ZA',
      channelType: 'bank',
    });

    expect(quote.payoutAmount).toBe(100000);
    expect(quote.ycFeeAmount).toBe(500);
    expect(quote.markupAmount).toBeGreaterThan(250);
    expect(quote.totalCharge).toBe(100000 + quote.ycFeeAmount + quote.markupAmount);
    expect(quote.flatBwp).toBe(100);
    expect(quote.ycFeeMarkup).toBe(250);
  });
});
