const yc = require('./yellowcard');
const { roundMoney, addMoney, subMoney, mulMoney, divideByRate, roundRate } = require('./money');

/** Customer pays YC_FEE_MULTIPLIER × YC disbursement fee; Romela Pula keeps the excess over 1×. */
const YC_FEE_MULTIPLIER = parseFloat(
  process.env.ROMELA_PULA_YC_FEE_MULTIPLIER || process.env.PAYLINK_YC_FEE_MULTIPLIER || '1.5'
);
const YC_FEE_ROMELA_PULA_MARKUP_PCT = YC_FEE_MULTIPLIER - 1; // 0.5 = 50% of YC fee

/**
 * Romela Pula flat service fee tiers (denominated in BWP).
 * Gaps (e.g. 501–1000) use the next tier's flat fee.
 */
function getRomelaPulaFlatFeeBwp(amountBwp) {
  const amt = parseFloat(amountBwp);
  if (!Number.isFinite(amt) || amt <= 0) return 5;
  if (amt <= 500) return 5;
  if (amt <= 2000) return 15;
  if (amt <= 5000) return 25;
  if (amt <= 25000) return 40;
  if (amt <= 100000) return 50;
  if (amt <= 500000) return 100;
  return 200;
}

async function getUsdRatesFor(currencies) {
  const rows = await Promise.all(currencies.map((c) => yc.getRateForCurrency(c)));
  return rows.map((row) => {
    const r = row?.sell ?? row?.buy;
    if (r == null) throw new Error('No exchange rate available for tier conversion');
    return parseFloat(r);
  });
}

/** Express a local-currency amount as BWP for tier lookup. */
async function amountToBwpTierBasis(amount, currency) {
  const amt = parseFloat(amount);
  if (currency === 'BWP') return amt;
  const [bwpPerUsd, ccyPerUsd] = await getUsdRatesFor(['BWP', currency]);
  return roundMoney(amt * (bwpPerUsd / ccyPerUsd));
}

/** Convert a BWP flat fee into another currency using YC /business/rates. */
async function flatBwpToCurrency(flatBwp, currency) {
  if (currency === 'BWP') return roundMoney(flatBwp);
  const [bwpPerUsd, ccyPerUsd] = await getUsdRatesFor(['BWP', currency]);
  return roundMoney(flatBwp * (ccyPerUsd / bwpPerUsd));
}

/**
 * Romela Pula service markup (profit + flat) in feeCurrency:
 *   tier flat fee (BWP tiers → converted) + 50% of YC disbursement fee.
 * Customer total fee = ycFeeAmount + markupAmount = flat + 1.5 × ycFee.
 */
async function buildRomelaPulaServiceMarkup({ tierBasisAmount, tierBasisCurrency, feeCurrency, ycFeeAmount }) {
  const ycFee = parseFloat(ycFeeAmount);
  const tierBwp = await amountToBwpTierBasis(tierBasisAmount, tierBasisCurrency);
  const flatBwp = getRomelaPulaFlatFeeBwp(tierBwp);
  const flatFee = await flatBwpToCurrency(flatBwp, feeCurrency);
  const ycFeeMarkup = mulMoney(ycFee, YC_FEE_ROMELA_PULA_MARKUP_PCT);
  const markupAmount = addMoney(flatFee, ycFeeMarkup);

  return {
    tierBwp,
    flatBwp,
    flatFee,
    ycFeeMarkup,
    markupAmount,
    customerFeeTotal: addMoney(ycFee, markupAmount),
  };
}

/**
 * Romela Pula gross profit on the service-fee components (excludes FX margin).
 * @returns {{ flatProfit, ycFeeProfit, serviceProfit, currency }}
 */
function computeRomelaPulaServiceProfit({ flatFee, ycFeeMarkup, currency }) {
  const flatProfit = parseFloat(flatFee);
  const ycFeeProfit = parseFloat(ycFeeMarkup);
  return {
    flatProfit,
    ycFeeProfit,
    serviceProfit: addMoney(flatProfit, ycFeeProfit),
    currency,
  };
}

/** Customer pays TOPUP_YC_FEE_MULTIPLIER × YC collection fee; Romela Pula keeps the excess over 1×. */
const TOPUP_FLAT_FEE_BWP = parseFloat(process.env.TOPUP_FLAT_FEE_BWP || '10');
const TOPUP_YC_FEE_MULTIPLIER = parseFloat(process.env.TOPUP_YC_FEE_MULTIPLIER || '1.2');
const TOPUP_YC_FEE_ROMELA_PULA_MARKUP_PCT = TOPUP_YC_FEE_MULTIPLIER - 1; // 0.2 = 20% of YC fee

/**
 * Romela Pula top-up markup in feeCurrency:
 *   BWP 10 flat (converted) + 20% of YC collection fee.
 * Customer total fee = ycFeeAmount + markupAmount = flat + 1.2 × ycFee.
 */
async function buildRomelaPulaTopupMarkup({ feeCurrency, ycFeeAmount }) {
  const ycFee = parseFloat(ycFeeAmount);
  const flatFee = await flatBwpToCurrency(TOPUP_FLAT_FEE_BWP, feeCurrency);
  const ycFeeMarkup = mulMoney(ycFee, TOPUP_YC_FEE_ROMELA_PULA_MARKUP_PCT);
  const markupAmount = addMoney(flatFee, ycFeeMarkup);

  return {
    flatBwp: TOPUP_FLAT_FEE_BWP,
    flatFee,
    ycFeeMarkup,
    markupAmount,
    totalFee: addMoney(ycFee, markupAmount),
  };
}

/** YC disbursement fee for a send — POST /business/fees/get-config (required). */
async function getYcSendFeeFromApi({ country, currency, channelType, amount }) {
  const feeConfig = await yc.getFeeConfig({
    txType: 'send',
    country,
    currency,
    channelType,
    directSettlement: false,
  });
  const svc = feeConfig?.serviceFee;
  if (!svc) {
    throw new Error(`No YC fee config for send ${country}/${currency}/${channelType}`);
  }
  return roundMoney(
    (svc.flatFeeLocal || 0) + Math.max(svc.minFeeLocal || 0, amount * ((svc.feePercentage || 0) / 100))
  );
}

/**
 * Invoice payment quote — supplier receives payoutAmount; payer debited totalCharge
 * (in invoice currency before wallet bridging).
 * Fees: true YC get-config + tiered BWP flat + 1.5× YC fee.
 */
async function buildInvoicePaymentQuote({ payoutAmount, currency, country, channelType }) {
  const face = parseFloat(payoutAmount);
  if (isNaN(face) || face <= 0) {
    throw new Error('Invalid invoice amount');
  }

  const ycFeeAmount = await getYcSendFeeFromApi({ country, currency, channelType, amount: face });
  const markup = await buildRomelaPulaServiceMarkup({
    tierBasisAmount: face,
    tierBasisCurrency: currency,
    feeCurrency: currency,
    ycFeeAmount,
  });

  const totalCharge = addMoney(face, ycFeeAmount, markup.markupAmount);

  return {
    payoutAmount: face,
    ycFeeAmount,
    markupAmount: markup.markupAmount,
    flatBwp: markup.flatBwp,
    flatFee: markup.flatFee,
    ycFeeMarkup: markup.ycFeeMarkup,
    tierBwp: markup.tierBwp,
    totalCharge,
  };
}

/** Customer-facing send service fee tiers (BWP equivalent of transfer size). */
const ROMELA_PULA_SEND_FEE_TIERS = [
  { label: 'Up to 500', feeBwp: 5 },
  { label: '501 – 2,000', feeBwp: 15 },
  { label: '2,001 – 5,000', feeBwp: 25 },
  { label: '5,001 – 25,000', feeBwp: 40 },
  { label: '25,001 – 100,000', feeBwp: 50 },
  { label: '100,001 – 500,000', feeBwp: 100 },
  { label: 'Over 500,000', feeBwp: 200 },
];

module.exports = {
  YC_FEE_MULTIPLIER,
  YC_FEE_ROMELA_PULA_MARKUP_PCT,
  TOPUP_FLAT_FEE_BWP,
  TOPUP_YC_FEE_MULTIPLIER,
  TOPUP_YC_FEE_ROMELA_PULA_MARKUP_PCT,
  ROMELA_PULA_SEND_FEE_TIERS,
  getRomelaPulaFlatFeeBwp,
  amountToBwpTierBasis,
  flatBwpToCurrency,
  buildRomelaPulaServiceMarkup,
  buildRomelaPulaTopupMarkup,
  computeRomelaPulaServiceProfit,
  getYcSendFeeFromApi,
  buildInvoicePaymentQuote,
};
