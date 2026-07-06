const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send a WhatsApp message to a user.
 * @param {string} toPhone - E.164 phone number, e.g. "+26771234567"
 * @param {string} body - message text
 * @param {string} [mediaUrl] - optional public URL (e.g. a PDF receipt) to attach
 */
async function sendWhatsApp(toPhone, body, mediaUrl) {
  const to = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;
  const fromRaw = process.env.TWILIO_WHATSAPP_NUMBER;
  const from = fromRaw && fromRaw.startsWith('whatsapp:') ? fromRaw : `whatsapp:${fromRaw}`;
  const payload = {
    from,
    to,
    body,
  };
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  return client.messages.create(payload);
}

module.exports = { sendWhatsApp };
