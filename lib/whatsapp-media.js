const { downloadTwilioMedia } = require('./twilio-media');
const { downloadWebDocument } = require('./web-media');

/**
 * Download inbound KYC media — Twilio media URL or PWA upload ref (web:{uuid}).
 */
async function downloadWhatsAppMedia(ref) {
  if (!ref) throw new Error('Missing media reference');
  if (String(ref).startsWith('web:')) return downloadWebDocument(ref);
  if (String(ref).startsWith('http://') || String(ref).startsWith('https://')) {
    return downloadTwilioMedia(ref);
  }
  throw new Error(`Unsupported media reference: ${ref}`);
}

module.exports = { downloadWhatsAppMedia };
