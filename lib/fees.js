const yc = require('./yellowcard');

const POBO_FLAT_FEE_USD = parseFloat(process.env.POBO_FLAT_FEE_USD || '25');
const POBO_FEE_PCT = parseFloat(process.env.POBO_FEE_PCT || '0.25');
const INVOICE_PROFIT_MARKUP_PCT = parseFloat(process.env.INVOICE_PROFIT_MARKUP_PCT || '1');

/**
 * Build the all-in quote for an invoice payment.
 * Supplier receives payoutAmount; payer is debited totalCharge.
 *
 * POBO fee = $25 USD (converted at YC sell rate) + 0.25% of invoice face value.
 * PayLink markup = INVOICE_PROFIT_MARKUP_PCT % of invoice face value.
 */
async function buildInvoicePaymentQuote({ payoutAmount, currency, country, channelType }) {
  const face = parseFloat(payoutAmount);
  if (isNaN(face) || face <= 0) {
    throw new Error('Invalid invoice amount');
  }

  const rate = await yc.getRateForCurrency(currency);
  const usdToLocal = rate?.sell || rate?.buy;
  if (!usdToLocal) {
    throw new Error(`No exchange rate available for ${currency}`);
  }

  const poboFlatLocal = parseFloat((POBO_FLAT_FEE_USD * usdToLocal).toFixed(2));
  const poboPercentLocal = parseFloat((face * (POBO_FEE_PCT / 100)).toFixed(2));
  let ycFeeAmount = parseFloat((poboFlatLocal + poboPercentLocal).toFixed(2));

  // Cross-check against YC fee config when available (use the higher of POBO floor vs API)
  try {
    const feeConfig = await yc.getFeeConfig({
      txType: 'send',
      country,
      currency,
      channelType,
      directSettlement: false,
    });
    const svc = feeConfig?.serviceFee;
    if (svc) {
      const apiFee = parseFloat(
        ((svc.flatFeeLocal || 0) + Math.max(svc.minFeeLocal || 0, face * ((svc.feePercentage || 0) / 100))).toFixed(2)
      );
      ycFeeAmount = Math.max(ycFeeAmount, apiFee);
    }
  } catch (e) {
    console.warn('[FEES] getFeeConfig unavailable, using POBO formula:', e.message);
  }

  const markupAmount = parseFloat((face * (INVOICE_PROFIT_MARKUP_PCT / 100)).toFixed(2));
  const totalCharge = parseFloat((face + ycFeeAmount + markupAmount).toFixed(2));

  return {
    payoutAmount: face,
    ycFeeAmount,
    markupAmount,
    totalCharge,
    poboFlatLocal,
    poboPercentLocal,
    rateUsed: usdToLocal,
  };
}

function formatInvoiceQuoteMessage(ctx, quote) {
  const { currency, invoiceCode } = ctx;
  const codeLine = invoiceCode ? `Invoice *${invoiceCode}*\n` : '';
  return (
    `${codeLine}*Payment quote*\n\n` +
    `Supplier receives: *${quote.payoutAmount.toFixed(2)} ${currency}*\n` +
    `Yellow Card POBO fee: *${quote.ycFeeAmount.toFixed(2)} ${currency}*\n` +
    `  ($${POBO_FLAT_FEE_USD} USD + ${POBO_FEE_PCT}%)\n` +
    `PayLink service fee: *${quote.markupAmount.toFixed(2)} ${currency}*\n` +
    `  (${INVOICE_PROFIT_MARKUP_PCT}%)\n\n` +
    `*Total debit from your wallet: ${quote.totalCharge.toFixed(2)} ${currency}*\n\n` +
    `Reply *confirm* to proceed, or *cancel* to go back.`
  );
}

module.exports = {
  POBO_FLAT_FEE_USD,
  POBO_FEE_PCT,
  INVOICE_PROFIT_MARKUP_PCT,
  buildInvoicePaymentQuote,
  formatInvoiceQuoteMessage,
};
