const { getRomelaPulaFlatFeeBwp, computeRomelaPulaServiceProfit } = require('../lib/fees');

describe('getRomelaPulaFlatFeeBwp', () => {
  it('returns 5 for amounts up to 500 BWP', () => {
    expect(getRomelaPulaFlatFeeBwp(100)).toBe(5);
    expect(getRomelaPulaFlatFeeBwp(500)).toBe(5);
  });

  it('returns 15 for 501–2000 BWP', () => {
    expect(getRomelaPulaFlatFeeBwp(501)).toBe(15);
    expect(getRomelaPulaFlatFeeBwp(2000)).toBe(15);
  });

  it('returns 50 for 25001–100000 BWP', () => {
    expect(getRomelaPulaFlatFeeBwp(82600)).toBe(50);
    expect(getRomelaPulaFlatFeeBwp(100000)).toBe(50);
  });

  it('returns 200 above 500000 BWP', () => {
    expect(getRomelaPulaFlatFeeBwp(600000)).toBe(200);
  });
});

describe('computeRomelaPulaServiceProfit', () => {
  it('sums flat fee and YC fee markup', () => {
    const profit = computeRomelaPulaServiceProfit({
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
