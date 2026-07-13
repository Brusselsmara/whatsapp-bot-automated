const {
  roundMoney,
  addMoney,
  subMoney,
  mulMoney,
  multiplyByRate,
  divideByRate,
  moneyEquals,
} = require('../lib/money');

describe('money helpers', () => {
  it('roundMoney avoids float drift', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(10.005)).toBe(10.01);
  });

  it('addMoney and subMoney use integer cents', () => {
    expect(addMoney(10.1, 20.2)).toBe(30.3);
    expect(subMoney(100, 0.01)).toBe(99.99);
  });

  it('mulMoney applies decimal factors', () => {
    expect(mulMoney(500, 0.5)).toBe(250);
  });

  it('multiplyByRate and divideByRate round consistently', () => {
    expect(multiplyByRate(983, 1.2155)).toBe(1194.84);
    expect(divideByRate(100000, 1.240306)).toBe(80625.27);
  });

  it('moneyEquals tolerates sub-cent drift', () => {
    expect(moneyEquals(10.001, 10.004)).toBe(true);
    expect(moneyEquals(10, 10.02)).toBe(false);
  });
});
