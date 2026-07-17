const { handleIncomingMessage } = require('../lib/conversation');
const {
  handleVerifyChallenge,
  verifyWebhookSignature,
  parseInboundWebhook,
  sendWhatsApp,
  isMetaWhatsAppConfigured,
} = require('../lib/whatsapp-meta');
const { captureError } = require('../lib/observability');

// Meta WhatsApp Cloud API webhook:
//   https://<your-vercel-app>.vercel.app/api/whatsapp

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const challenge = handleVerifyChallenge(req.query);
    if (challenge != null) {
      console.log('[WHATSAPP] Webhook verified (Meta challenge)');
      return res.status(200).send(challenge);
    }
    return res.status(200).send('PayLink WhatsApp webhook OK');
  }

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.warn(`[WHATSAPP] Rejected ${req.method} request`);
    return res.status(405).send('Method not allowed');
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-hub-signature-256'];

  if (process.env.NODE_ENV === 'production') {
    if (!getAppSecretConfigured()) {
      console.error('[WHATSAPP] WHATSAPP_APP_SECRET is required in production');
      return res.status(503).send('Webhook not configured');
    }
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('[WHATSAPP] Invalid Meta webhook signature');
      return res.status(403).send('Invalid signature');
    }
  } else if (getAppSecretConfigured() && !verifyWebhookSignature(rawBody, signature)) {
    console.warn('[WHATSAPP] Invalid signature (non-production — continuing)');
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  const messages = parseInboundWebhook(body);
  if (messages.length === 0) {
    return res.status(200).send('OK');
  }

  if (!isMetaWhatsAppConfigured()) {
    console.error('[WHATSAPP] Meta WhatsApp not configured — dropping inbound messages');
    return res.status(503).send('WhatsApp not configured');
  }

  for (const inbound of messages) {
    console.log(`[WHATSAPP] Inbound from ${inbound.phone}: ${JSON.stringify(inbound.text)}`);

    let reply;
    try {
      reply = await handleIncomingMessage(inbound.phone, inbound.text, inbound.mediaRefs);
    } catch (err) {
      captureError(err, {
        handler: 'whatsapp',
        fromPhone: inbound.phone,
        text: inbound.text,
      });
      reply = 'Sorry, something went wrong. Please reply "menu" to start over.';
    }

    try {
      await sendWhatsApp(inbound.phone, reply);
    } catch (err) {
      captureError(err, {
        handler: 'whatsapp_send',
        fromPhone: inbound.phone,
      });
      console.error('[WHATSAPP] Failed to send reply:', err.message);
    }
  }

  return res.status(200).send('OK');
};

function getAppSecretConfigured() {
  return !!(process.env.WHATSAPP_APP_SECRET || '').trim();
}
