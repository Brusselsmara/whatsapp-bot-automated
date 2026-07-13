const yc = require('./yellowcard');

/** Customer pays YC_FEE_MULTIPLIER × YC disbursement fee; PayLink keeps the excess over 1×. */
const YC_FEE_MULTIPLIER = parseFloat(process.env.PAYLINK_YC_FEE_MULTIPLIER || '1.5');
const YC_FEE_PAYLINK_MARKUP_PCT = YC_FEE_MULTIPLIER - 1; // 0.5 = 50% of YC fee

/**
 * PayLink flat service fee tiers (denominated in BWP).
 * Gaps (e.g. 501–1000) use the next tier's flat fee.
 */
function getPaylinkFlatFeeBwp(amountBwp) {
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
  return parseFloat((amt * (bwpPerUsd / ccyPerUsd)).toFixed(2));
}

/** Convert a BWP flat fee into another currency using YC /business/rates. */
async function flatBwpToCurrency(flatBwp, currency) {
  if (currency === 'BWP') return parseFloat(flatBwp.toFixed(2));
  const [bwpPerUsd, ccyPerUsd] = await getUsdRatesFor(['BWP', currency]);
  return parseFloat((flatBwp * (ccyPerUsd / bwpPerUsd)).toFixed(2));
}

/**
 * PayLink service markup (profit + flat) in feeCurrency:
 *   tier flat fee (BWP tiers → converted) + 50% of YC disbursement fee.
 * Customer total fee = ycFeeAmount + markupAmount = flat + 1.5 × ycFee.
 */
async function buildPaylinkServiceMarkup({ tierBasisAmount, tierBasisCurrency, feeCurrency, ycFeeAmount }) {
  const ycFee = parseFloat(ycFeeAmount);
  const tierBwp = await amountToBwpTierBasis(tierBasisAmount, tierBasisCurrency);
  const flatBwp = getPaylinkFlatFeeBwp(tierBwp);
  const flatFee = await flatBwpToCurrency(flatBwp, feeCurrency);
  const ycFeeMarkup = parseFloat((ycFee * YC_FEE_PAYLINK_MARKUP_PCT).toFixed(2));
  const markupAmount = parseFloat((flatFee + ycFeeMarkup).toFixed(2));

  return {
    tierBwp,
    flatBwp,
    flatFee,
    ycFeeMarkup,
    markupAmount,
    customerFeeTotal: parseFloat((ycFee + markupAmount).toFixed(2)),
  };
}

/**
 * PayLink gross profit on the service-fee components (excludes FX margin).
 * @returns {{ flatProfit, ycFeeProfit, serviceProfit, currency }}
 */
function computePaylinkServiceProfit({ flatFee, ycFeeMarkup, currency }) {
  const flatProfit = parseFloat(flatFee);
  const ycFeeProfit = parseFloat(ycFeeMarkup);
  return {
    flatProfit,
    ycFeeProfit,
    serviceProfit: parseFloat((flatProfit + ycFeeProfit).toFixed(2)),
    currency,
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
  return parseFloat(
    ((svc.flatFeeLocal || 0) + Math.max(svc.minFeeLocal || 0, amount * ((svc.feePercentage || 0) / 100))).toFixed(2)
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
  const markup = await buildPaylinkServiceMarkup({
    tierBasisAmount: face,
    tierBasisCurrency: currency,
    feeCurrency: currency,
    ycFeeAmount,
  });

  const totalCharge = parseFloat((face + ycFeeAmount + markup.markupAmount).toFixed(2));

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

module.exports = {
  YC_FEE_MULTIPLIER,
  YC_FEE_PAYLINK_MARKUP_PCT,
  getPaylinkFlatFeeBwp,
  amountToBwpTierBasis,
  flatBwpToCurrency,
  buildPaylinkServiceMarkup,
  computePaylinkServiceProfit,
  getYcSendFeeFromApi,
  buildInvoicePaymentQuote,
};
