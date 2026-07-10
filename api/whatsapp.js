const twilio = require('twilio');
const { handleIncomingMessage } = require('../lib/conversation');

// This is the URL you'll paste into Twilio's WhatsApp Sandbox / Sender config:
//   https://<your-vercel-app>.vercel.app/api/whatsapp

module.exports = async (req, res) => {
  // Twilio Console URL checks and browser probes send GET/HEAD — return 200 so
  // they don't surface as Error 11200. Real inbound WhatsApp messages are POST.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).send('PayLink WhatsApp webhook OK');
  }

  if (req.method !== 'POST') {
    console.warn(`[WHATSAPP] Rejected ${req.method} request`);
    return res.status(405).send('Method not allowed');
  }

  // Verify the request really came from Twilio (protects against spoofed webhooks).
  const signature = req.headers['x-twilio-signature'];
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  const configuredUrl = baseUrl ? `${baseUrl}/api/whatsapp` : null;

  // Also build URL from the actual request — must match what Twilio signed.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const requestUrl = host ? `${proto}://${host}/api/whatsapp` : null;

  const candidateUrls = [...new Set([configuredUrl, requestUrl].filter(Boolean))];
  const isValid = candidateUrls.some((url) =>
    twilio.validateRequest(authToken, signature, url, req.body)
  );

  if (!isValid && process.env.NODE_ENV === 'production') {
    console.error('[WHATSAPP] Invalid signature', { candidateUrls, host });
    return res.status(403).send('Invalid signature');
  }

  const fromPhone = (req.body.From || '').replace('whatsapp:', '');
  const text = req.body.Body || '';

  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    if (req.body[`MediaUrl${i}`]) mediaUrls.push(req.body[`MediaUrl${i}`]);
  }

  let reply;
  try {
    reply = await handleIncomingMessage(fromPhone, text, mediaUrls);
  } catch (err) {
    console.error('Error handling message:', err);
    reply = 'Sorry, something went wrong. Please reply "menu" to start over.';
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};

// Vercel needs the raw/parsed body for Twilio's form-encoded webhook.
module.exports.config = {
  api: {
    bodyParser: {
      // Twilio sends application/x-www-form-urlencoded; Vercel's default
      // bodyParser handles this fine, no special config needed here.
    },
  },
};
