const querystring = require('querystring');
const twilio = require('twilio');
const { handleIncomingMessage } = require('../lib/conversation');
const { getPublicAppUrl } = require('../lib/app-url');
const { captureError } = require('../lib/observability');

// This is the URL you'll paste into Twilio's WhatsApp Sandbox / Sender config:
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

function webhookUrlCandidates(req) {
  const baseUrl = getPublicAppUrl();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const path = '/api/whatsapp';

  const urls = [];
  if (baseUrl) urls.push(`${baseUrl}${path}`);
  if (host) {
    urls.push(`${proto}://${host}${path}`);
    // Twilio always signs https; try https even if proto header differs
    if (proto !== 'https') urls.push(`https://${host}${path}`);
  }
  return [...new Set(urls)];
}

function validateTwilioSignature(req, params) {
  const signature = req.headers['x-twilio-signature'];
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !signature) return false;

  return webhookUrlCandidates(req).some((url) =>
    twilio.validateRequest(authToken, signature, url, params)
  );
}

module.exports = async (req, res) => {
  // Twilio Console URL checks send GET/HEAD — return 200 so they don't log Error 11200.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).send('PayLink WhatsApp webhook OK');
  }

  if (req.method !== 'POST') {
    console.warn(`[WHATSAPP] Rejected ${req.method} request`);
    return res.status(405).send('Method not allowed');
  }

  const rawBody = await readRawBody(req);
  const params = querystring.parse(rawBody);

  const isValid = validateTwilioSignature(req, params);
  if (!isValid && process.env.NODE_ENV === 'production') {
    console.error('[WHATSAPP] Invalid signature', {
      urls: webhookUrlCandidates(req),
      host: req.headers.host,
      hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN,
    });
    return res.status(403).send('Invalid signature');
  }

  const fromPhone = (params.From || '').replace('whatsapp:', '');
  const text = params.Body || '';
  console.log(`[WHATSAPP] Inbound from ${fromPhone}: ${JSON.stringify(text)}`);

  const numMedia = parseInt(params.NumMedia || '0', 10);
  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    if (params[`MediaUrl${i}`]) mediaUrls.push(params[`MediaUrl${i}`]);
  }

  let reply;
  try {
    reply = await handleIncomingMessage(fromPhone, text, mediaUrls);
  } catch (err) {
    captureError(err, { handler: 'whatsapp', fromPhone, text });
    reply = 'Sorry, something went wrong. Please reply "menu" to start over.';
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};
