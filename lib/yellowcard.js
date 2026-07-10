const crypto = require('crypto');

const BASE_URL = process.env.YELLOWCARD_BASE_URL; // e.g. https://sandbox.api.yellowcard.io
const API_KEY = process.env.YELLOWCARD_API_KEY;
const SECRET_KEY = process.env.YELLOWCARD_SECRET_KEY;

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
 * Build the two required auth headers for every request.
 * Message signed = ISO8601 timestamp + path + METHOD + (base64(sha256(body)) if POST/PUT)
 */
function buildAuthHeaders(path, method, body) {
  const timestamp = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(timestamp, 'utf8');
  hmac.update(path, 'utf8');
  hmac.update(method.toUpperCase(), 'utf8');

  if (body) {
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64');
    hmac.update(bodyHash, 'utf8');
  }

  const signature = hmac.digest('base64');

  return {
    'Content-Type': 'application/json',
    'X-YC-Timestamp': timestamp,
    'Authorization': `YcHmacV1 ${API_KEY}:${signature}`,
  };
}

async function ycRequest(method, path, body, timeoutMs = 15000) {
  // Yellow Card's docs example signs a bare path like "/business/payments/accept"
  // with no query string shown. Sign just the pathname (not "?country=BW" etc.)
  // in case their server verifies against the path only — the actual HTTP
  // request still goes to the full path+query.
  const pathname = path.split('?')[0];
  const headers = buildAuthHeaders(pathname, method, body);

  // Hard timeout so a slow/hanging YC API call fails fast instead of running
  // until Vercel kills the whole function (which leaves the user with no
  // reply at all — looks like "nothing happened").
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
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
 * Verify an incoming webhook actually came from Yellow Card.
 * Per https://docs.yellowcard.engineering/docs/webhooks-api :
 * X-YC-Signature = base64(sha256(rawBody)) signed with your secret key.
 * @param {string} rawBody - the exact raw request body string (not re-serialized JSON)
 * @param {string} signatureHeader - value of the X-YC-Signature header
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch etc.
  }
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
    destination,
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
  toInternationalPhone,
  buildAuthHeaders,
  verifyWebhookSignature,
  getChannels,
  getNetworks,
  submitReceive,
  acceptReceive,
  getReceive,
  submitSend,
  acceptSend,
  getSend,
};