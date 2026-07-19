const PARTNER_LEAK = /yellow\s*card|yellowcard|yc\s+api|yellowcard_/i;

/** Strip payment-partner branding from text shown to customers. */
function stripPartnerBranding(text) {
  return String(text || '')
    .replace(/Yellow Card API error[^]*?(?=\.|$)/gi, '')
    .replace(/Yellow Card[^.]*\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isPartnerLeak(text) {
  return PARTNER_LEAK.test(String(text || ''));
}

/**
 * Safe customer-facing message from an internal error (never expose partner names).
 */
function userFacingErrorMessage(err, fallback = 'Something went wrong. Please try again.') {
  const raw = err?.data?.message || err?.message || String(err || '');
  if (!raw || isPartnerLeak(raw)) return fallback;
  const cleaned = stripPartnerBranding(raw);
  if (!cleaned || isPartnerLeak(cleaned)) return fallback;
  return cleaned;
}

module.exports = {
  stripPartnerBranding,
  isPartnerLeak,
  userFacingErrorMessage,
};
