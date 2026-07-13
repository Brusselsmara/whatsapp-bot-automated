const { getPaylinkFlatFeeBwp, computePaylinkServiceProfit } = require('../lib/fees');

describe('getPaylinkFlatFeeBwp', () => {
  it('returns 5 for amounts up to 500 BWP', () => {
    expect(getPaylinkFlatFeeBwp(100)).toBe(5);
    expect(getPaylinkFlatFeeBwp(500)).toBe(5);
  });

  it('returns 15 for 501–2000 BWP', () => {
    expect(getPaylinkFlatFeeBwp(501)).toBe(15);
    expect(getPaylinkFlatFeeBwp(2000)).toBe(15);
  });

  it('returns 50 for 25001–100000 BWP', () => {
    expect(getPaylinkFlatFeeBwp(82600)).toBe(50);
    expect(getPaylinkFlatFeeBwp(100000)).toBe(50);
  });

  it('returns 200 above 500000 BWP', () => {
    expect(getPaylinkFlatFeeBwp(600000)).toBe(200);
  });
});

describe('computePaylinkServiceProfit', () => {
  it('sums flat fee and YC fee markup', () => {
    const profit = computePaylinkServiceProfit({
      flatFee: 50,
      ycFeeMarkup: 250,
      currency: 'ZAR',
    });
    expect(profit.flatProfit).toBe(50);
    expect(profit.ycFeeProfit).toBe(250);
    expect(profit.serviceProfit).toBe(300);
    expect(profit.currency).toBe('ZAR');
  });
});
