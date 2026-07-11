const yc = require('./yellowcard');

const FX_RATE_MULTIPLIER_BASE = parseFloat(process.env.FX_RATE_MULTIPLIER_BASE || '1.75');
const QUOTE_LOCK_MINUTES = parseInt(process.env.QUOTE_LOCK_MINUTES || '10', 10);
const DEFAULT_FX_MARGIN_PCT = 0.02;

/**
 * Per-business FX margin from users.fx_margin_pct (default 2%, VIP e.g. 1%).
 */
function getUserFxMargin(user) {
  const m = parseFloat(user?.fx_margin_pct);
  return Number.isFinite(m) ? m : DEFAULT_FX_MARGIN_PCT;
}

/**
 * Outbound send display rate: YC rate × (1.75 − MARGIN_PERCENTAGE).
 */
function applyFxMargin(ycRate, marginPct) {
  const base = parseFloat(ycRate);
  if (!Number.isFinite(base) || base <= 0) throw new Error('Invalid rate from quote');
  return parseFloat((base * (FX_RATE_MULTIPLIER_BASE - marginPct)).toFixed(6));
}

function isQuoteExpired(quote) {
  if (!quote?.expiresAt) return false;
  return new Date(quote.expiresAt).getTime() <= Date.now();
}

function isQuoteExpiredError(err) {
  if (err?.status !== 400) return false;
  const msg = `${err.data?.code || ''} ${err.data?.message || err.message || ''}`.toLowerCase();
  return msg.includes('quote') && msg.includes('expir');
}

function minutesUntilExpiry(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}

/**
 * Fetch live conversion quote from Yellow Card /quotes and apply business margin.
 */
async function buildSendQuote({ user, localAmount, currency, country, channelType }) {
  const marginPct = getUserFxMargin(user);
  const raw = await yc.getConversionQuote({
    txType: 'send',
    localAmount,
    currency,
    country,
    channelType,
  });

  const ycRate = parseFloat(raw.rate);
  const displayRate = applyFxMargin(ycRate, marginPct);
  const payout = parseFloat(localAmount);
  const usdFromQuote = raw.usdAmount != null
    ? parseFloat(raw.usdAmount)
    : parseFloat((payout / ycRate).toFixed(2));
  const usdDisplay = parseFloat((payout / displayRate).toFixed(2));

  return {
    quoteId: raw.quoteId,
    ycRate,
    displayRate,
    marginPct,
    usdAmount: usdFromQuote,
    usdDisplay,
    expiresAt: raw.expiresAt,
    raw,
  };
}

function formatSendQuoteMessage(ctx, quote, { includeConfirm = true } = {}) {
  const mins = minutesUntilExpiry(quote.expiresAt);
  const lines = [
    `*Live FX quote* (${ctx.currency})`,
    '',
    `Recipient receives: *${parseFloat(ctx.payoutAmount || ctx.amount).toFixed(2)} ${ctx.currency}*`,
    `Yellow Card rate: *${quote.ycRate.toFixed(4)}*`,
    `Your rate (incl. ${(quote.marginPct * 100).toFixed(1)}% margin): *${quote.displayRate.toFixed(4)}*`,
    `USD settlement (YC): *$${quote.usdAmount.toFixed(2)}*`,
    `USD at your rate: *$${quote.usdDisplay.toFixed(2)}*`,
    '',
    `⏳ *Estimate valid for ${QUOTE_LOCK_MINUTES} minutes* (~${mins} min). Final rate locks when you confirm payment.`,
    `Rate ref: \`${quote.quoteId}\``,
  ];

  if (ctx.purpose === 'invoice_payment' && ctx.ycFeeAmount != null) {
    const walletCcy = ctx.walletCurrency || ctx.currency;
    const feeLines = [
      `POBO + service fees: *${(parseFloat(ctx.ycFeeAmount) + parseFloat(ctx.markupAmount || 0)).toFixed(2)} ${ctx.currency}*`,
    ];
    // Cross-currency invoice — the invoice's own total (face value + fees)
    // gets bridged back to the payer's home-currency wallet, same math as
    // Workflow 3's cross-border sends (see buildInvoiceWalletBridge).
    if (ctx.fxBridgeDisplayRate != null) {
      feeLines.push(`Bridging rate: *1 ${walletCcy} = ${parseFloat(ctx.fxBridgeDisplayRate).toFixed(4)} ${ctx.currency}*`);
    }
    feeLines.push(`*Total wallet debit: ${parseFloat(ctx.amount).toFixed(2)} ${walletCcy}*`, '');
    lines.splice(4, 0, ...feeLines);
  }

  if (includeConfirm) {
    lines.push('', 'Reply *confirm* to pay at this rate, *1* to refresh, or *cancel* to go back.');
  }

  return lines.join('\n');
}

const QUOTE_EXPIRED_MSG =
  'Your quote expired. Reply *1* to refresh the live rate, or *cancel* to go back.';

// ============================================================
// "Send money" fee model (Workflow 3 — separate from the invoice-payment
// POBO fee model above, which is untouched). Two cases:
//
//  1. Domestic — wallet currency == recipient currency. No FX conversion.
//     Fee = YC's own send fee marked up by a flat %.
//  2. Cross-border — wallet currency != recipient currency. Bridged
//     through USD (never exposed to the user as a wallet), FX margin
//     shaved off the bridged rate, plus a flat cross-border fee.
//
// In both cases YC's send fee is looked up using the SENDER's home
// country/currency/channel — the fee is always paid by the sender in
// their own currency, never converted.
// ============================================================

const DOMESTIC_FEE_FLAT_AMOUNT = parseFloat(process.env.DOMESTIC_FEE_FLAT_AMOUNT || '5');
const DOMESTIC_FEE_FLAT_THRESHOLD = parseFloat(process.env.DOMESTIC_FEE_FLAT_THRESHOLD || '500');
const DOMESTIC_FEE_PCT_ABOVE_THRESHOLD = parseFloat(process.env.DOMESTIC_FEE_PCT_ABOVE_THRESHOLD || '0.01');
const CROSSBORDER_FEE_MARKUP_PCT = parseFloat(process.env.CROSSBORDER_FEE_MARKUP_PCT || '0.07');
const CROSSBORDER_FX_MARGIN_PCT = parseFloat(process.env.CROSSBORDER_FX_MARGIN_PCT || '0.02');
const CROSSBORDER_VIP_FX_MARGIN_PCT = parseFloat(process.env.CROSSBORDER_VIP_FX_MARGIN_PCT || '0.01');
const CROSSBORDER_VIP_MIN_AMOUNT_BWP = parseFloat(process.env.CROSSBORDER_VIP_MIN_AMOUNT_BWP || '500000');

/**
 * YC's own send fee, in the given currency, for the given amount.
 * Returns 0 (rather than throwing) if YC's fee-config endpoint is
 * unavailable — we still want to be able to quote the margin/markup.
 */
async function getYcSendFeeAmount({ country, currency, channelType, amount }) {
  try {
    const feeConfig = await yc.getFeeConfig({ txType: 'send', country, currency, channelType, directSettlement: false });
    const svc = feeConfig?.serviceFee;
    if (!svc) return 0;
    return parseFloat(
      ((svc.flatFeeLocal || 0) + Math.max(svc.minFeeLocal || 0, amount * ((svc.feePercentage || 0) / 100))).toFixed(2)
    );
  } catch (e) {
    console.warn('[QUOTES] getFeeConfig unavailable, assuming 0 YC fee:', e.message);
    return 0;
  }
}

/**
 * Domestic markup (on top of YC's own send fee) — the same tiered formula
 * for both bank and momo, in whatever currency the send itself is in
 * (BWP/ZAR/ZMW — the flat amount and threshold aren't currency-converted,
 * they apply as literal numbers regardless of currency):
 *   amount <= threshold  -> flat DOMESTIC_FEE_FLAT_AMOUNT
 *   amount >  threshold  -> flat DOMESTIC_FEE_FLAT_AMOUNT + PCT × (amount − threshold)
 */
function getDomesticMarkup(amount) {
  const amt = parseFloat(amount);
  if (amt <= DOMESTIC_FEE_FLAT_THRESHOLD) {
    return parseFloat(DOMESTIC_FEE_FLAT_AMOUNT.toFixed(2));
  }
  const excess = amt - DOMESTIC_FEE_FLAT_THRESHOLD;
  return parseFloat((DOMESTIC_FEE_FLAT_AMOUNT + excess * DOMESTIC_FEE_PCT_ABOVE_THRESHOLD).toFixed(2));
}

/**
 * Domestic send fee (same currency in and out): YC's own fee plus the
 * tiered markup above. Hidden breakdown — callers should only show the
 * combined totalFee to the user.
 */
async function buildDomesticSendFee({ country, currency, channelType, amount }) {
  const ycFeeAmount = await getYcSendFeeAmount({ country, currency, channelType, amount });
  const markupAmount = getDomesticMarkup(amount);
  const totalFee = parseFloat((ycFeeAmount + markupAmount).toFixed(2));
  return { ycFeeAmount, markupAmount, totalFee };
}

/**
 * VIP cross-border corridor: business accounts sending BWP -> South Africa
 * (ZAR) of at least CROSSBORDER_VIP_MIN_AMOUNT_BWP get a reduced FX margin.
 * Everything else uses the standard margin.
 */
function getCrossBorderMargin({ accountType, sourceCurrency, destCountry, sourceAmount }) {
  const isVip =
    accountType === 'business' &&
    sourceCurrency === 'BWP' &&
    destCountry === 'ZA' &&
    parseFloat(sourceAmount) >= CROSSBORDER_VIP_MIN_AMOUNT_BWP;
  return isVip ? CROSSBORDER_VIP_FX_MARGIN_PCT : CROSSBORDER_FX_MARGIN_PCT;
}

/**
 * Bridges sourceCurrency -> destCurrency via each side's USD rate
 * (yc.getRateForCurrency, no quoteId/lock needed for an estimate) and
 * shaves the business's FX margin off the bridged rate. Shared by both
 * cross-border sends (Workflow 3) and cross-currency invoice payments
 * (Workflow 4), so both use the exact same bridging math.
 *
 * The VIP-margin check is denominated in a BWP source amount, which for
 * the "solve for source amount" case (invoice bridging) isn't known until
 * *after* we've picked a margin — so callers that don't already know the
 * source amount should pass sourceAmountForVip=0 for a first pass, then
 * re-call with the resulting estimate to confirm VIP eligibility.
 */
async function getBridgedRate({ accountType, sourceCurrency, destCurrency, destCountry, sourceAmountForVip }) {
  const [rate1Data, rate2Data] = await Promise.all([
    yc.getRateForCurrency(sourceCurrency),
    yc.getRateForCurrency(destCurrency),
  ]);
  const rate1 = rate1Data?.sell || rate1Data?.buy;
  const rate2 = rate2Data?.sell || rate2Data?.buy;
  if (!rate1 || !rate2) {
    throw new Error(`No exchange rate available for ${sourceCurrency} or ${destCurrency}`);
  }

  const bridgedRate = rate2 / rate1; // destCurrency per 1 sourceCurrency, before margin
  const marginPct = getCrossBorderMargin({ accountType, sourceCurrency, destCountry, sourceAmount: sourceAmountForVip });
  const displayRate = parseFloat((bridgedRate * (1 - marginPct)).toFixed(6));
  return { rate1, rate2, bridgedRate, marginPct, displayRate };
}

/**
 * Unlocked estimate for a cross-border send — source amount (the sender's
 * wallet debit, minus fees) is already known/fixed; solves for the
 * destination amount the recipient gets. The real locked quote (with a
 * quoteId to pass to submitSend) is only fetched at execution time, via
 * lockCrossBorderQuote below — this keeps the "lock" window as short as
 * possible and avoids a stale-quote/expiry UX entirely for this flow.
 */
async function buildCrossBorderEstimate({ accountType, sourceCurrency, sourceCountry, destCurrency, destCountry, channelType, sourceAmount }) {
  const ycFeeAmount = await getYcSendFeeAmount({
    country: sourceCountry,
    currency: sourceCurrency,
    channelType,
    amount: sourceAmount,
  });
  const markupAmount = parseFloat((ycFeeAmount * CROSSBORDER_FEE_MARKUP_PCT).toFixed(2));
  const totalFee = parseFloat((ycFeeAmount + markupAmount).toFixed(2));

  const { rate1, rate2, bridgedRate, marginPct, displayRate } = await getBridgedRate({
    accountType, sourceCurrency, destCurrency, destCountry, sourceAmountForVip: sourceAmount,
  });
  const destAmountEstimate = parseFloat((parseFloat(sourceAmount) * displayRate).toFixed(2));

  return { ycFeeAmount, markupAmount, totalFee, rate1, rate2, bridgedRate, marginPct, displayRate, destAmountEstimate };
}

/**
 * Reverse of buildCrossBorderEstimate — used when the DESTINATION amount is
 * fixed (an invoice's total in its own currency, face value + POBO fees)
 * and we need to work out how much of the sender's home-currency wallet
 * must be debited to cover it. Same bridged-rate + margin math, just
 * solved for the source (wallet) amount instead of the destination amount
 * — the margin is still applied in the business's favour, so the sender
 * pays slightly more source currency for the same fixed destination total.
 */
async function buildInvoiceWalletBridge({ accountType, walletCurrency, invoiceCurrency, invoiceCountry, invoiceTotal }) {
  // Two-pass: the VIP threshold is denominated in a BWP *source* (wallet)
  // amount, which we only know once we've picked a margin — estimate once
  // with a neutral guess, then re-check VIP eligibility against that.
  let { rate1, rate2, bridgedRate, marginPct, displayRate } = await getBridgedRate({
    accountType, sourceCurrency: walletCurrency, destCurrency: invoiceCurrency, destCountry: invoiceCountry, sourceAmountForVip: 0,
  });
  let walletAmount = parseFloat((parseFloat(invoiceTotal) / displayRate).toFixed(2));

  const recheckMarginPct = getCrossBorderMargin({ accountType, sourceCurrency: walletCurrency, destCountry: invoiceCountry, sourceAmount: walletAmount });
  if (recheckMarginPct !== marginPct) {
    marginPct = recheckMarginPct;
    displayRate = parseFloat((bridgedRate * (1 - marginPct)).toFixed(6));
    walletAmount = parseFloat((parseFloat(invoiceTotal) / displayRate).toFixed(2));
  }

  return { rate1, rate2, bridgedRate, marginPct, displayRate, walletAmount };
}

/**
 * Rates-based estimate for the destination leg (same source as buildSendQuote).
 * The real rate is locked by submitSend at execution time per YC docs.
 */
async function lockCrossBorderQuote({ destCurrency, destCountry, channelType, destAmount }) {
  return yc.getConversionQuote({
    txType: 'send',
    localAmount: destAmount,
    currency: destCurrency,
    country: destCountry,
    channelType,
  });
}

function formatDomesticFeeMessage(ctx) {
  return (
    `*Sending ${parseFloat(ctx.payoutAmount).toFixed(2)} ${ctx.currency}* to ${ctx.recipientName}\n\n` +
    `Total fees: *${(parseFloat(ctx.ycFeeAmount) + parseFloat(ctx.markupAmount)).toFixed(2)} ${ctx.currency}*\n` +
    `*Total debit: ${parseFloat(ctx.amount).toFixed(2)} ${ctx.currency}*\n\n` +
    `Reply *confirm* to proceed, or *cancel* to go back.`
  );
}

function formatCrossBorderQuoteMessage(ctx) {
  return (
    `*Cross-border transfer to ${ctx.recipientName}*\n\n` +
    `You send: *${parseFloat(ctx.sourceAmount).toFixed(2)} ${ctx.walletCurrency}*\n` +
    `Recipient receives ≈ *${parseFloat(ctx.payoutAmount).toFixed(2)} ${ctx.currency}*\n` +
    `Exchange rate: *1 ${ctx.walletCurrency} = ${parseFloat(ctx.displayRate).toFixed(4)} ${ctx.currency}*\n` +
    `Cross-border fee: *${(parseFloat(ctx.ycFeeAmount) + parseFloat(ctx.markupAmount)).toFixed(2)} ${ctx.walletCurrency}*\n\n` +
    `*Total debit: ${parseFloat(ctx.amount).toFixed(2)} ${ctx.walletCurrency}*\n\n` +
    `Reply *confirm* to proceed, or *cancel* to go back.`
  );
}

module.exports = {
  FX_RATE_MULTIPLIER_BASE,
  QUOTE_LOCK_MINUTES,
  DEFAULT_FX_MARGIN_PCT,
  getUserFxMargin,
  applyFxMargin,
  isQuoteExpired,
  isQuoteExpiredError,
  buildSendQuote,
  formatSendQuoteMessage,
  QUOTE_EXPIRED_MSG,

  // Send-money fee model
  DOMESTIC_FEE_FLAT_AMOUNT,
  DOMESTIC_FEE_FLAT_THRESHOLD,
  DOMESTIC_FEE_PCT_ABOVE_THRESHOLD,
  CROSSBORDER_FEE_MARKUP_PCT,
  CROSSBORDER_FX_MARGIN_PCT,
  CROSSBORDER_VIP_FX_MARGIN_PCT,
  CROSSBORDER_VIP_MIN_AMOUNT_BWP,
  getYcSendFeeAmount,
  getDomesticMarkup,
  buildDomesticSendFee,
  getCrossBorderMargin,
  getBridgedRate,
  buildCrossBorderEstimate,
  buildInvoiceWalletBridge,
  lockCrossBorderQuote,
  formatDomesticFeeMessage,
  formatCrossBorderQuoteMessage,
};
