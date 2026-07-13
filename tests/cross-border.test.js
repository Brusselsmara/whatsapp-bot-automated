jest.mock('../lib/yellowcard', () => ({
  getRateForCurrency: jest.fn(),
  getFeeConfig: jest.fn(),
}));

const yc = require('../lib/yellowcard');
const { mockGetRateForCurrency } = require('./helpers/mock-rates');
const { buildCrossBorderEstimate } = require('../lib/quotes');

beforeEach(() => {
  yc.getRateForCurrency.mockImplementation(mockGetRateForCurrency);
  yc.getFeeConfig.mockResolvedValue({
    serviceFee: { flatFeeLocal: 5, minFeeLocal: 0, feePercentage: 0.5 },
  });
});

describe('buildCrossBorderEstimate', () => {
  it('solves principal + fees = totalDebit within tolerance', async () => {
    const totalDebit = 1000;
    const result = await buildCrossBorderEstimate({
      accountType: 'individual',
      sourceCurrency: 'BWP',
      sourceCountry: 'BW',
      destCurrency: 'ZAR',
      destCountry: 'ZA',
      channelType: 'bank',
      totalDebit,
    });

    expect(result.totalDebit).toBe(totalDebit);
    expect(result.principalFx + result.totalFee).toBeCloseTo(totalDebit, 1);
    expect(result.principalFx).toBeGreaterThan(0);
    expect(result.destAmountEstimate).toBeGreaterThan(0);
    expect(result.displayRate).toBeLessThan(result.bridgedRate);
  });
});
