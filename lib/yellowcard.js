const crypto = require('crypto');

const QUOTE_LOCK_MS = 10 * 60 * 1000;

/** YC sandbox magic payer accounts — https://docs.yellowcard.engineering/docs/sandbox-testing-api */
const SANDBOX_BANK_SUCCESS_ACCOUNT = '1111111111';
const SANDBOX_BANK_FAILURE_ACCOUNT = '0000000000';

function getYcCredentials() {
  return {
    baseUrl: (process.env.YELLOWCARD_BASE_URL || '').trim().replace(/\/$/, ''),
    apiKey: (process.env.YELLOWCARD_API_KEY || '').trim(),
    secretKey: (process.env.YELLOWCARD_SECRET_KEY || '').trim(),
  };
}

function isYcSandbox() {
  const { baseUrl } = getYcCredentials();
  return /sandbox\.api\.yellowcard\.io/i.test(baseUrl);
}

// Confirmed against Yellow Card's docs (docs.yellowcard.engineering):
// - Auth scheme: "YcHmacV1" — https://docs.yellowcard.engineering/docs/authentication-api
// - Endpoints below use the current (v2) "/receive" and "/send" naming.
//   The old "/collections" and "/payments" paths still work but are deprecated.
// - Country coverage confirmed against https://docs.yellowcard.engineering/docs/africa
//   → of your 5 target countries, only Botswana (BW), South Africa (ZA), and
//   Zambia (ZM) are currently supported. Namibia and Zimbabwe are NOT yet
//   supported by Yellow Card as of writing this. See COUNTRY_CONFIG below.

// Source of truth: https://docs.yellowcard.engineering/docs/africa
// Receives:  BW=bank+momo, ZA=bank, ZM=momo
// Sends:     BW=bank+momo, ZA=bank, ZM=momo
const COUNTRY_CONFIG = {
  BW: { currency: 'BWP', channelTypes: ['bank', 'momo'], dialCode: '267' },
  ZA: { currency: 'ZAR', channelTypes: ['bank'],          dialCode: '27'  },
  ZM: { currency: 'ZMW', channelTypes: ['momo'],          dialCode: '260' },
};

/**
 * Normalise a phone/account number to E.164 international format (+CCXXXXXXXXX).
 * Yellow Card requires this for momo account numbers and recipient phone fields.
 *
 * Handles:
 *   "0771234567"    => "+267771234567"  (leading 0 replaced by dial code)
 *   "771234567"     => "+267771234567"  (bare local number)
 *   "267771234567"  => "+267771234567"  (already has dial code, no +)
 *   "+267771234567" => "+267771234567"  (already correct, pass through)
 *
 * @param {string} number  - raw number as typed by the user
 * @param {string} country - ISO 3166-1 alpha-2 code, e.g. "BW"
 * @returns {string} E.164 formatted number, e.g. "+267771234567"
 */
function toInternationalPhone(number, country) {
  const digits = String(number).replace(/\D/g, ''); // strip all non-digits
  const dialCode = COUNTRY_CONFIG[country]?.dialCode;

  if (!dialCode) return '+' + digits;                              // unknown country - best effort
  if (digits.startsWith(dialCode)) return '+' + digits;           // already has dial code
  if (digits.startsWith('0')) return '+' + dialCode + digits.slice(1); // leading 0
  return '+' + dialCode + digits;                                  // bare local number
}

/**
 * Reverse of toInternationalPhone: given a raw number (with or without a
 * leading '+', with or without a leading '0'), work out which supported
 * country it belongs to by matching against COUNTRY_CONFIG dial codes.
 *
 * Matches longest dial code first so that adding new countries later (e.g.
 * one whose dial code is a prefix of another) never needs new logic here —
 * just add the entry to COUNTRY_CONFIG.
 *
 * A bare local number (no dial code, no leading 0 either — e.g. "771234567")
 * is ambiguous across countries and returns null; callers should treat that
 * as "please include your country code" rather than silently guessing.
 *
 * @param {string} rawNumber - number as typed by the user
 * @returns {{ country: string, currency: string } | null}
 */
function detectCountryFromNumber(rawNumber) {
  const digits = String(rawNumber || '').replace(/\D/g, '');
  if (!digits) return null;

  const entries = Object.entries(COUNTRY_CONFIG).sort(
    (a, b) => b[1].dialCode.length - a[1].dialCode.length
  );

  for (const [country, cfg] of entries) {
    if (digits.startsWith(cfg.dialCode)) {
      return { country, currency: cfg.currency };
    }
  }
  return null;
}

/** True when the number's dial code is Botswana (+267), Zambia (+260), or South Africa (+27). */
function isSupportedWhatsAppNumber(rawNumber) {
  return detectCountryFromNumber(rawNumber) !== null;
}

/**
 * Build the two required auth headers for every request.
 * Message signed = ISO8601 timestamp + path + METHOD + (base64(sha256(body)) if POST/PUT)
 */
function buildAuthHeaders(path, method, bodyStr) {
  const { apiKey, secretKey } = getYcCredentials();
  if (!apiKey || !secretKey) {
    throw new Error('YELLOWCARD_API_KEY and YELLOWCARD_SECRET_KEY must be set in environment variables');
  }

  const timestamp = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(timestamp, 'utf8');
  hmac.update(path, 'utf8');
  hmac.update(method.toUpperCase(), 'utf8');

  if (bodyStr != null && bodyStr.length > 0) {
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('base64');
    hmac.update(bodyHash, 'utf8');
  }

  const signature = hmac.digest('base64');

  return {
    'Content-Type': 'application/json',
    'X-YC-Timestamp': timestamp,
    'Authorization': `YcHmacV1 ${apiKey}:${signature}`,
  };
}

async function ycRequest(method, path, body, timeoutMs = 15000) {
  const { baseUrl } = getYcCredentials();
  if (!baseUrl) {
    throw new Error('YELLOWCARD_BASE_URL must be set in environment variables');
  }

  const pathname = path.split('?')[0];
  const bodyStr = body != null ? JSON.stringify(body) : undefined;
  const headers = buildAuthHeaders(pathname, method, bodyStr);

  // Hard timeout so a slow/hanging YC API call fails fast instead of running
  // until Vercel kills the whole function (which leaves the user with no
  // reply at all — looks like "nothing happened").
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Yellow Card API timed out after ${timeoutMs}ms: ${method} ${path}`);
      timeoutErr.status = 504;
      timeoutErr.data = { code: 'Timeout', message: timeoutErr.message };
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    const err = new Error(`Yellow Card API redirected (${res.status}) to ${res.headers.get('location') || 'unknown'} — check YELLOWCARD_BASE_URL`);
    err.status = res.status;
    err.data = { code: 'Redirect', message: err.message };
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Yellow Card API error (${res.status}): ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Extract Yellow Card webhook signature from request headers.
 * Supports X-YC-Signature (documented) and Yellowcard-Signature aliases.
 */
function getWebhookSignature(headers = {}) {
  const h = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return h['x-yc-signature'] || h['yellowcard-signature'] || h['x-yellowcard-signature'] || null;
}

/**
 * Verify an incoming webhook actually came from Yellow Card.
 * Per https://docs.yellowcard.engineering/docs/webhooks-api :
 * HMAC-SHA256 of the raw body using YELLOWCARD_SECRET_KEY, base64-encoded.
 * @param {string} rawBody - the exact raw request body string (not re-serialized JSON)
 * @param {string} signatureHeader - value of the signature header
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const { secretKey } = getYcCredentials();
  if (!signatureHeader || !secretKey) return false;
  const expected = crypto.createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/** Retrieve USD/local rate for a currency (sell = local units per 1 USD). */
async function getRateForCurrency(currency) {
  const path = currency ? `/business/rates?currency=${currency}` : '/business/rates';
  const data = await ycRequest('GET', path);
  const rates = Array.isArray(data?.rates) ? data.rates : (Array.isArray(data) ? data : []);
  return rates.find((r) => r.code === currency) || rates[0] || null;
}

/**
 * Resolve Bank Account — POST /business/details/bank. Validates a bank
 * account and returns the registered account holder's name before any
 * money moves. Only available for bank accounts in select countries per
 * Yellow Card's docs; there is no equivalent endpoint for mobile money.
 */
async function resolveBankAccount({ accountNumber, networkId }) {
  return ycRequest('POST', '/business/details/bank', { accountNumber, networkId });
}

/**
 * True if a failed resolveBankAccount call means "no account found for
 * that number" (as opposed to a transient/auth/network error) — per
 * Yellow Card's error codes: ResolveAccountError, InvalidRequestBody.
 */
function isAccountNotFoundError(err) {
  if (!err || err.status !== 400) return false;
  const code = err.data?.code || '';
  const msg = `${code} ${err.data?.message || err.message || ''}`.toLowerCase();
  return (
    code === 'ResolveAccountError' ||
    code === 'InvalidRequestBody' ||
    msg.includes('not found') ||
    msg.includes('no match')
  );
}

/** Pick a sensible default network from an active-networks list. */
function pickPreferredNetwork(networks) {
  if (!networks || networks.length === 0) return null;
  return (
    networks.find((n) => ['myzaka', 'orange', 'mascom', 'btc'].some((k) => n.name?.toLowerCase().includes(k))) ||
    networks[0]
  );
}

/** Fee config for a send/receive — see POST /business/fees/get-config */
async function getFeeConfig({ txType, country, currency, channelType, directSettlement = false }) {
  return ycRequest('POST', '/business/fees/get-config', {
    txType,
    country,
    currency,
    channelType,
    directSettlement,
  });
}

/**
 * FX estimate for outbound sends / invoice settlement legs.
 *
 * Yellow Card does NOT expose POST /business/quotes in the public API —
 * submitSend itself locks the rate for ~10 minutes. For user-facing
 * estimates we use GET /business/rates and apply business margin in
 * lib/quotes.js before the user confirms.
 */
async function getConversionQuote({ txType, localAmount, currency, country, channelType }) {
  const rateRow = await getRateForCurrency(currency);
  const rate = rateRow?.sell ?? rateRow?.buy;
  if (rate == null) {
    throw new Error(`No exchange rate available for ${currency}`);
  }

  const ycRate = parseFloat(rate);
  const expiresAt = new Date(Date.now() + QUOTE_LOCK_MS).toISOString();
  const usdAmount = parseFloat((localAmount / ycRate).toFixed(2));
  console.log('[YC] getConversionQuote via /business/rates:', JSON.stringify({ txType, localAmount, currency, country, channelType }), 'rate=', ycRate);

  return {
    quoteId: rateRow.rateId || `rate-${currency}`,
    rate: ycRate,
    expiresAt,
    usdAmount,
    raw: { ...rateRow, estimate: true },
  };
}

/**
 * List active payment channels for a country, so we know which channelId/
 * channelType to use. Filter to status === 'active' per Yellow Card's guidance.
 */
async function getChannels(country) {
  const data = await ycRequest('GET', `/business/channels?country=${country}`);
  return Array.isArray(data) ? data.filter((c) => c.status === 'active') : data;
}

/**
 * Submit a "receive" request — money coming IN from a customer (e.g. paying
 * an invoice). Uses channelType instead of a specific channelId, which lets
 * Yellow Card auto-pick an active channel for the country+currency.
 *
 * forceAccept:true skips the separate "accept" step, so the receive starts
 * processing immediately — simpler for a chat bot flow than a 2-step accept.
 *
 * @param {object} params
 * @param {string} params.sequenceId - your own unique id for this transaction (use invoice_code)
 * @param {number} params.localAmount - amount in local currency
 * @param {string} params.country - ISO 3166-2 country code, e.g. "BW"
 * @param {string} params.channelType - "bank" or "momo"
 * @param {object} params.recipient - KYC details of whoever is being paid out to (your business)
 * @param {object} params.source - payer's account details: { accountType, accountNumber, networkId? }
 */
async function submitReceive({ sequenceId, localAmount, country, channelType, currency, recipient, source, customerUID }) {
  const payload = {
    sequenceId,
    localAmount,
    country,
    currency,
    channelType,
    recipient,
    source,
    customerType: 'retail',
    forceAccept: true,
    customerUID,
  };
  console.log('[YC] submitReceive payload:', JSON.stringify(payload, null, 2));
  return ycRequest('POST', '/business/receive', payload);
}

/** Accept a receive request that was NOT force-accepted (2-step flow). */
async function acceptReceive(receiveId) {
  return ycRequest('POST', `/business/receive/${receiveId}/accept`);
}

/** Look up a receive request by Yellow Card's id. */
async function getReceive(receiveId) {
  return ycRequest('GET', `/business/receive/${receiveId}`);
}

/**
 * Yellow Card requires destination accountName to contain only letters and spaces.
 * Strips digits, punctuation, and symbols; collapses whitespace.
 */
function sanitizeDestinationName(name) {
  if (!name || typeof name !== 'string') return 'PayLink Recipient';
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'PayLink Recipient';
}

/**
 * Submit a "send" request — money going OUT to a recipient (payout / direct
 * send / invoice settlement to a supplier).
 *
 * @param {object} params
 * @param {string} params.sequenceId - your own unique id (use your transaction id)
 * @param {number} params.localAmount - amount in local currency
 * @param {string} params.country
 * @param {string} params.channelType - "bank" or "momo"
 * @param {string} params.reason - e.g. "invoice_settlement", "other"
 * @param {object} params.sender - your business's KYC details (customerType institution) or the individual sender's
 * @param {object} params.destination - { accountName, accountNumber, accountType, networkId }
 */
async function submitSend({ sequenceId, localAmount, country, currency, channelType, reason, sender, destination, customerUID }) {
  const payload = {
    sequenceId,
    localAmount,
    country,
    currency,
    channelType,
    reason,
    sender,
    destination: {
      ...destination,
      accountName: sanitizeDestinationName(destination.accountName),
    },
    customerType: 'retail',
    forceAccept: true,
    customerUID,
  };
  console.log('[YC] submitSend payload:', JSON.stringify(payload, null, 2));
  return ycRequest('POST', '/business/send', payload);
}

/** Accept a send that was submitted without forceAccept (or as a safety fallback). */
async function acceptSend(sendId) {
  return ycRequest('POST', `/business/send/${sendId}/accept`);
}

async function getSend(sendId) {
  return ycRequest('GET', `/business/send/${sendId}`);
}

/**
 * List active networks (specific banks / mobile money providers) for a
 * country, optionally filtered to accountNumberType 'bank' or 'momo'.
 */
async function getNetworks(country, accountNumberType) {
  const data = await ycRequest('GET', `/business/networks?country=${country}`);
  console.log(`[YC] getNetworks raw response for ${country}:`, JSON.stringify(data));
  const list = Array.isArray(data) ? data : (Array.isArray(data?.networks) ? data.networks : []);
  const active = list.filter((n) => n.status === 'active');
  const filtered = accountNumberType ? active.filter((n) => n.accountNumberType === accountNumberType || n.channelType === accountNumberType) : active;
  console.log(`[YC] getNetworks: total=${list.length} active=${active.length} filtered(${accountNumberType})=${filtered.length}`);
  return filtered;
}

module.exports = {
  COUNTRY_CONFIG,
  SANDBOX_BANK_SUCCESS_ACCOUNT,
  SANDBOX_BANK_FAILURE_ACCOUNT,
  isYcSandbox,
  toInternationalPhone,
  detectCountryFromNumber,
  isSupportedWhatsAppNumber,
  sanitizeDestinationName,
  buildAuthHeaders,
  getWebhookSignature,
  verifyWebhookSignature,
  getRateForCurrency,
  resolveBankAccount,
  isAccountNotFoundError,
  pickPreferredNetwork,
  getFeeConfig,
  getConversionQuote,
  getChannels,
  getNetworks,
  submitReceive,
  acceptReceive,
  getReceive,
  submitSend,
  acceptSend,
  getSend,
};