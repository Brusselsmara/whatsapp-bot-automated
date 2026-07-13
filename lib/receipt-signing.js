const crypto = require('crypto');
const { publicAppUrl } = require('./app-url');

function getSigningSecret() {
  return (process.env.RECEIPT_SIGNING_SECRET || process.env.CRON_SECRET || '').trim();
}

/** In production, require a valid signature when a signing secret is configured. */
function isReceiptSigningEnforced() {
  return process.env.NODE_ENV === 'production' && !!getSigningSecret();
}

function signReceiptId(txnId) {
  const secret = getSigningSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(String(txnId)).digest('hex').slice(0, 32);
}

function verifyReceiptSignature(txnId, sig) {
  const expected = signReceiptId(txnId);
  if (!expected || !sig || typeof sig !== 'string') return false;
  const provided = sig.slice(0, 32);
  if (provided.length !== 32) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

function buildReceiptUrl(txnId) {
  const sig = signReceiptId(txnId);
  const path = sig ? `/api/receipt?id=${txnId}&sig=${sig}` : `/api/receipt?id=${txnId}`;
  return publicAppUrl(path);
}

module.exports = {
  getSigningSecret,
  isReceiptSigningEnforced,
  signReceiptId,
  verifyReceiptSignature,
  buildReceiptUrl,
};
