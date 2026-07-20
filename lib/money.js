/** Scale for fiat amounts (2 decimal places → integer minor units). */
const MONEY_SCALE = 100;

/**
 * Convert a decimal amount to integer minor units (e.g. BWP 10.50 → 1050).
 */
function toMinor(amount, scale = MONEY_SCALE) {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) throw new Error('Invalid amount');
  return Math.round(n * scale);
}

/** Convert integer minor units back to a decimal amount. */
function fromMinor(minor, scale = MONEY_SCALE) {
  return minor / scale;
}

/** Round to 2 decimal places via integer minor units. */
function roundMoney(amount) {
  return fromMinor(toMinor(amount));
}

function addMoney(...amounts) {
  const sum = amounts.reduce((acc, a) => acc + toMinor(a), 0);
  return fromMinor(sum);
}

function subMoney(a, b) {
  return fromMinor(toMinor(a) - toMinor(b));
}

/** Multiply amount by a decimal factor (e.g. 0.5 for 50% markup). */
function mulMoney(amount, factor) {
  const f = parseFloat(factor);
  if (!Number.isFinite(f)) throw new Error('Invalid factor');
  return fromMinor(Math.round(toMinor(amount) * f));
}

/** amount × rate, rounded to 2 dp (rate may have up to 6 dp). */
function multiplyByRate(amount, rate, rateDecimals = 6) {
  const amountMinor = BigInt(toMinor(amount));
  const rateFactor = 10 ** rateDecimals;
  const rateInt = BigInt(Math.round(parseFloat(rate) * rateFactor));
  if (rateInt <= 0n) throw new Error('Invalid rate');
  const rateFactorBig = BigInt(rateFactor);
  const half = rateFactorBig / 2n;
  const minorResult = Number((amountMinor * rateInt + half) / rateFactorBig);
  return fromMinor(minorResult);
}

/** amount ÷ rate, rounded to 2 dp (rate may have up to 6 dp). */
function divideByRate(amount, rate, rateDecimals = 6) {
  const amountMinor = BigInt(toMinor(amount));
  const rateFactor = 10 ** rateDecimals;
  const rateInt = BigInt(Math.round(parseFloat(rate) * rateFactor));
  if (rateInt <= 0n) throw new Error('Invalid rate');
  const rateFactorBig = BigInt(rateFactor);
  const half = rateInt / 2n;
  const minorResult = Number((amountMinor * rateFactorBig + half) / rateInt);
  return fromMinor(minorResult);
}

/** Round FX rates to 6 dp without float drift on display. */
function roundRate(rate, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round(parseFloat(rate) * factor) / factor;
}

/** True when two money amounts differ by less than 1 minor unit (1 cent). */
function moneyEquals(a, b) {
  return Math.abs(toMinor(a) - toMinor(b)) < 1;
}

module.exports = {
  MONEY_SCALE,
  toMinor,
  fromMinor,
  roundMoney,
  addMoney,
  subMoney,
  mulMoney,
  multiplyByRate,
  divideByRate,
  roundRate,
  moneyEquals,
};
