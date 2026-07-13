const yc = require('./yellowcard');
const { buildPaylinkServiceMarkup, buildPaylinkTopupMarkup } = require('./fees');
const {
  roundMoney,
  addMoney,
  subMoney,
  multiplyByRate,
  divideByRate,
  roundRate,
  moneyEquals,
} = require('./money');

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
  return roundRate(base * (FX_RATE_MULTIPLIER_BASE - marginPct));
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
  const walletCcy = ctx.walletCurrency || ctx.currency;
  const lines = [
    `*Payment quote* (${ctx.currency})`,
    '',
    `Recipient receives: *${parseFloat(ctx.payoutAmount || ctx.amount).toFixed(2)} ${ctx.currency}*`,
  ];

  if (ctx.purpose === 'invoice_payment' && ctx.ycFeeAmount != null) {
    if (ctx.fxBridgeDisplayRate != null) {
      lines.push(`Exchange rate: *1 ${walletCcy} = ${parseFloat(ctx.fxBridgeDisplayRate).toFixed(4)} ${ctx.currency}*`);
      lines.push(`Fees: *${computeInvoiceCustomerFeesWallet(ctx).toFixed(2)} ${walletCcy}*`);
    } else {
      const fees = (parseFloat(ctx.ycFeeAmount) + parseFloat(ctx.markupAmount || 0)).toFixed(2);
      lines.push(`Fees: *${fees} ${ctx.currency}*`);
    }
    lines.push(`*Total wallet debit: ${parseFloat(ctx.amount).toFixed(2)} ${walletCcy}*`);
  }

  lines.push(
    '',
    `⏳ *Quote valid for ${QUOTE_LOCK_MINUTES} minutes* (~${mins} min). Rate and fees refresh from Yellow Card when you reply *1*.`,
    `Rate ref: \`${quote.quoteId}\``,
  );

  if (includeConfirm) {
    lines.push('', 'Reply *confirm* to pay at this quote, *1* to refresh, or *cancel* to go back.');
  }

  return lines.join('\n');
}

/**
 * All-in customer fees in wallet currency for a cross-currency invoice:
 * YC disbursement fee + PayLink markups (bridged) + FX margin on the payout.
 * Same-currency invoices: yc_fee_amount + markup_amount in invoice currency.
 */
function computeInvoiceCustomerFeesWallet(ctx) {
  const face = parseFloat(ctx.payoutAmount);
  const walletDebit = parseFloat(ctx.amount);

  if (!ctx.fxBridgedRate || !ctx.fxBridgeDisplayRate) {
    return addMoney(ctx.ycFeeAmount || 0, ctx.markupAmount || 0);
  }

  const bridgedRate = parseFloat(ctx.fxBridgedRate);
  if (!Number.isFinite(bridgedRate) || bridgedRate <= 0) {
    throw new Error('Invalid bridged rate for fee calculation');
  }

  const principalWallet = divideByRate(face, bridgedRate);
  return subMoney(walletDebit, principalWallet);
}

/** Reconstruct all-in wallet fees from a saved transaction row. */
function computeInvoiceCustomerFeesFromTxn(txn) {
  if (!txn || txn.type !== 'invoice_payment') return 0;
  const face = parseFloat(txn.payout_amount);
  const walletDebit = parseFloat(txn.amount);
  const payoutCurrency = txn.payout_currency || txn.currency;
  const isCross = payoutCurrency !== txn.currency;

  if (!isCross || !txn.display_rate) {
    return addMoney(txn.yc_fee_amount || 0, txn.markup_amount || 0);
  }

  const displayRate = parseFloat(txn.display_rate);
  const marginPct = parseFloat(txn.margin_pct ?? CROSSBORDER_FX_MARGIN_PCT);
  const bridgedRate = displayRate / (1 - marginPct);
  return subMoney(walletDebit, divideByRate(face, bridgedRate));
}

const QUOTE_EXPIRED_MSG =
  'Your quote expired. Reply *1* to refresh the live rate, or *cancel* to go back.';

// ============================================================
// Send / invoice service fees (Workflow 3 & 4):
//   tiered BWP flat fee + 1.5× YC disbursement fee (see lib/fees.js).
// Cross-border FX margin unchanged (2% standard, 1% VIP BWP→ZA).
// ============================================================

const CROSSBORDER_FX_MARGIN_PCT = parseFloat(process.env.CROSSBORDER_FX_MARGIN_PCT || '0.02');
const CROSSBORDER_VIP_FX_MARGIN_PCT = parseFloat(process.env.CROSSBORDER_VIP_FX_MARGIN_PCT || '0.01');
const CROSSBORDER_VIP_MIN_AMOUNT_BWP = parseFloat(process.env.CROSSBORDER_VIP_MIN_AMOUNT_BWP || '500000');

/**
 * YC fee from POST /business/fees/get-config (send or receive).
 * @param {{ required?: boolean }} opts - when required, throws instead of returning 0
 */
async function getYcFeeAmount({ txType = 'send', country, currency, channelType, amount }, opts = {}) {
  const { required = false } = opts;
  try {
    const feeConfig = await yc.getFeeConfig({ txType, country, currency, channelType, directSettlement: false });
    const svc = feeConfig?.serviceFee;
    if (!svc) {
      if (required) throw new Error(`No YC fee config for ${txType} ${country}/${currency}/${channelType}`);
      return 0;
    }
    return roundMoney(
      (svc.flatFeeLocal || 0) + Math.max(svc.minFeeLocal || 0, amount * ((svc.feePercentage || 0) / 100))
    );
  } catch (e) {
    if (required) throw e;
    console.warn('[QUOTES] getFeeConfig unavailable, assuming 0 YC fee:', e.message);
    return 0;
  }
}

/** @deprecated alias — use getYcFeeAmount({ txType: 'send', ... }) */
async function getYcSendFeeAmount(args, opts) {
  return getYcFeeAmount({ ...args, txType: 'send' }, opts);
}

/** Convert a destination-currency YC fee to wallet currency using the display rate. */
function destFeeToWalletCurrency(feeDest, displayRate) {
  const rate = parseFloat(displayRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid FX rate for fee conversion');
  return divideByRate(feeDest, rate);
}

/**
 * Domestic send fee (same currency in and out): YC fee + tiered PayLink markup.
 */
async function buildDomesticSendFee({ country, currency, channelType, amount }) {
  const ycFeeAmount = await getYcFeeAmount({ txType: 'send', country, currency, channelType, amount });
  const markup = await buildPaylinkServiceMarkup({
    tierBasisAmount: amount,
    tierBasisCurrency: currency,
    feeCurrency: currency,
    ycFeeAmount,
  });
  const totalFee = addMoney(ycFeeAmount, markup.markupAmount);
  return { ycFeeAmount, markupAmount: markup.markupAmount, totalFee, flatBwp: markup.flatBwp };
}

/**
 * Top-up (receive/collection) fee: BWP 10 flat + 1.2× YC collection fee.
 * Fee is deducted from the wallet credit when the top-up completes successfully.
 */
async function buildTopupFee({ country, currency, channelType, amount }) {
  const principal = parseFloat(amount);
  const ycFeeAmount = await getYcFeeAmount(
    { txType: 'receive', country, currency, channelType, amount: principal },
    { required: true }
  );
  const markup = await buildPaylinkTopupMarkup({ feeCurrency: currency, ycFeeAmount });
  const totalFee = markup.totalFee;
  const netCredit = subMoney(principal, totalFee);
  return { ycFeeAmount, markupAmount: markup.markupAmount, totalFee, netCredit };
}

function formatTopupFeeNotice({ amount, currency, topupFee, netCredit }) {
  return (
    `A top-up fee of *${parseFloat(topupFee).toFixed(2)} ${currency}* will be deducted once your top-up of *${parseFloat(amount).toFixed(2)} ${currency}* completes successfully.\n\n` +
    `*${parseFloat(netCredit).toFixed(2)} ${currency}* will be added to your wallet.`
  );
}

function formatTopupSettlementMessage({ grossAmount, netAmount, feeAmount, currency, newBalance }) {
  return (
    `✅ Top-up of *${parseFloat(grossAmount).toFixed(2)} ${currency}* confirmed!\n\n` +
    `Top-up fee deducted: *${parseFloat(feeAmount).toFixed(2)} ${currency}*\n` +
    `*${parseFloat(netAmount).toFixed(2)} ${currency}* added to your wallet.\n` +
    `New balance: *${parseFloat(newBalance).toFixed(2)} ${currency}*.`
  );
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
  const displayRate = roundRate(bridgedRate * (1 - marginPct));
  return { rate1, rate2, bridgedRate, marginPct, displayRate };
}

/** Destination-leg fees for a given FX principal (wallet currency, pre-fee). */
async function crossBorderFeesAtPrincipal({ sourceCurrency, destCountry, destCurrency, channelType, principalFx, displayRate }) {
  const destAmountEstimate = multiplyByRate(principalFx, displayRate);
  const ycFeeDest = await getYcFeeAmount(
    { txType: 'send', country: destCountry, currency: destCurrency, channelType, amount: destAmountEstimate },
    { required: true }
  );
  const ycFeeWallet = destFeeToWalletCurrency(ycFeeDest, displayRate);
  const markup = await buildPaylinkServiceMarkup({
    tierBasisAmount: principalFx,
    tierBasisCurrency: sourceCurrency,
    feeCurrency: sourceCurrency,
    ycFeeAmount: ycFeeWallet,
  });
  const totalFee = addMoney(ycFeeWallet, markup.markupAmount);
  return {
    ycFeeAmount: ycFeeWallet,
    ycFeeDest,
    markupAmount: markup.markupAmount,
    flatBwp: markup.flatBwp,
    totalFee,
    destAmountEstimate,
  };
}

/**
 * Cross-border estimate when the user enters the total wallet debit (fees
 * included). Solves iteratively: principalFx + fee(principalFx) = totalDebit.
 */
async function buildCrossBorderEstimate({ accountType, sourceCurrency, sourceCountry, destCurrency, destCountry, channelType, totalDebit }) {
  const total = parseFloat(totalDebit);
  if (!Number.isFinite(total) || total <= 0) throw new Error('Invalid amount');

  let { rate1, rate2, bridgedRate, marginPct, displayRate } = await getBridgedRate({
    accountType, sourceCurrency, destCurrency, destCountry, sourceAmountForVip: total,
  });

  let principalFx = total;
  let fees = null;
  for (let i = 0; i < 12; i++) {
    const marginRecheck = getCrossBorderMargin({
      accountType, sourceCurrency, destCountry, sourceAmount: principalFx,
    });
    if (marginRecheck !== marginPct) {
      marginPct = marginRecheck;
      displayRate = roundRate(bridgedRate * (1 - marginPct));
    }

    fees = await crossBorderFeesAtPrincipal({
      sourceCurrency, destCountry, destCurrency, channelType, principalFx, displayRate,
    });
    const principalNext = subMoney(total, fees.totalFee);
    if (principalNext <= 0) {
      throw new Error('Amount too low after fees');
    }
    if (moneyEquals(principalNext, principalFx)) {
      principalFx = principalNext;
      fees = await crossBorderFeesAtPrincipal({
        sourceCurrency, destCountry, destCurrency, channelType, principalFx, displayRate,
      });
      break;
    }
    principalFx = principalNext;
  }

  if (!fees || principalFx <= 0) {
    throw new Error('Amount too low after fees');
  }

  const destAmountEstimate = multiplyByRate(principalFx, displayRate);

  return {
    principalFx,
    totalDebit: total,
    ycFeeAmount: fees.ycFeeAmount,
    ycFeeDest: fees.ycFeeDest,
    markupAmount: fees.markupAmount,
    totalFee: fees.totalFee,
    rate1,
    rate2,
    bridgedRate,
    marginPct,
    displayRate,
    destAmountEstimate,
  };
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
  let walletAmount = divideByRate(invoiceTotal, displayRate);

  const recheckMarginPct = getCrossBorderMargin({ accountType, sourceCurrency: walletCurrency, destCountry: invoiceCountry, sourceAmount: walletAmount });
  if (recheckMarginPct !== marginPct) {
    marginPct = recheckMarginPct;
    displayRate = roundRate(bridgedRate * (1 - marginPct));
    walletAmount = divideByRate(invoiceTotal, displayRate);
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
  const customerFee = parseFloat(ctx.ycFeeAmount) + parseFloat(ctx.markupAmount);
  return (
    `*Cross-border transfer to ${ctx.recipientName}*\n\n` +
    `*Total you pay: ${parseFloat(ctx.amount).toFixed(2)} ${ctx.walletCurrency}* _(fees included)_\n` +
    `Recipient receives ≈ *${parseFloat(ctx.payoutAmount).toFixed(2)} ${ctx.currency}*\n` +
    `Exchange rate: *1 ${ctx.walletCurrency} = ${parseFloat(ctx.displayRate).toFixed(4)} ${ctx.currency}*\n` +
    `Fees included in total: *${customerFee.toFixed(2)} ${ctx.walletCurrency}*\n\n` +
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
  computeInvoiceCustomerFeesWallet,
  computeInvoiceCustomerFeesFromTxn,
  QUOTE_EXPIRED_MSG,

  // Send-money fee model
  CROSSBORDER_FX_MARGIN_PCT,
  CROSSBORDER_VIP_FX_MARGIN_PCT,
  CROSSBORDER_VIP_MIN_AMOUNT_BWP,
  getYcFeeAmount,
  getYcSendFeeAmount,
  destFeeToWalletCurrency,
  buildDomesticSendFee,
  buildTopupFee,
  formatTopupFeeNotice,
  formatTopupSettlementMessage,
  getCrossBorderMargin,
  getBridgedRate,
  buildCrossBorderEstimate,
  buildInvoiceWalletBridge,
  lockCrossBorderQuote,
  formatDomesticFeeMessage,
  formatCrossBorderQuoteMessage,
};
