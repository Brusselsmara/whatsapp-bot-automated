const twilio = require('twilio');

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function isTwilioWhatsAppConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER);
}

/**
 * Send a WhatsApp message to a user.
 * @param {string} toPhone - E.164 phone number, e.g. "+26771234567"
 * @param {string} body - message text
 * @param {string} [mediaUrl] - optional public URL (e.g. a PDF receipt) to attach
 */
async function sendWhatsApp(toPhone, body, mediaUrl) {
  const client = getClient();
  if (!client) throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');

  const to = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;
  const fromRaw = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!fromRaw) throw new Error('TWILIO_WHATSAPP_NUMBER is not configured');
  const from = fromRaw.startsWith('whatsapp:') ? fromRaw : `whatsapp:${fromRaw}`;

  const payload = { from, to, body };
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  return client.messages.create(payload);
}

module.exports = { sendWhatsApp, isTwilioWhatsAppConfigured, getClient };
