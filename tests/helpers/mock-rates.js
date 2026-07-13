/** Fixed USD rates for deterministic fee/FX tests (sell rate per 1 USD). */
const MOCK_USD_RATES = {
  BWP: { sell: 0.074, buy: 0.073 },
  ZAR: { sell: 0.054, buy: 0.053 },
  ZMW: { sell: 0.042, buy: 0.041 },
};

function mockGetRateForCurrency(currency) {
  const row = MOCK_USD_RATES[currency];
  if (!row) throw new Error(`No mock rate for ${currency}`);
  return Promise.resolve(row);
}

module.exports = { MOCK_USD_RATES, mockGetRateForCurrency };
