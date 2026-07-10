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
    `⏳ *This rate is locked for ${QUOTE_LOCK_MINUTES} minutes* (~${mins} min remaining).`,
    `Quote ID: \`${quote.quoteId}\``,
  ];

  if (ctx.purpose === 'invoice_payment' && ctx.ycFeeAmount != null) {
    lines.splice(4, 0,
      `POBO + service fees: *${(parseFloat(ctx.ycFeeAmount) + parseFloat(ctx.markupAmount || 0)).toFixed(2)} ${ctx.currency}*`,
      `*Total wallet debit: ${parseFloat(ctx.amount).toFixed(2)} ${ctx.currency}*`,
      ''
    );
  }

  if (includeConfirm) {
    lines.push('', 'Reply *confirm* to pay at this rate, *1* to refresh, or *cancel* to go back.');
  }

  return lines.join('\n');
}

const QUOTE_EXPIRED_MSG =
  'Your quote expired. Reply *1* to refresh the live rate, or *cancel* to go back.';

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
};
