const crypto = require('crypto');

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function getAccessToken() {
  return (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
}

function getPhoneNumberId() {
  return (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
}

function getAppSecret() {
  return (process.env.WHATSAPP_APP_SECRET || '').trim();
}

function getVerifyToken() {
  return (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
}

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/^whatsapp:/i, '').trim();
  if (!raw) return raw;
  return raw.startsWith('+') ? raw : `+${raw}`;
}

function toWhatsAppId(phone) {
  return normalizePhone(phone).replace(/\D/g, '');
}

function isMetaWhatsAppConfigured() {
  return !!(getAccessToken() && getPhoneNumberId());
}

/** Meta webhook subscription handshake (GET). */
function handleVerifyChallenge(query = {}) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && token === getVerifyToken() && challenge) {
    return String(challenge);
  }
  return null;
}

/** Verify X-Hub-Signature-256 on inbound webhook POST. */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = getAppSecret();
  if (!secret || !signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  if (expected.length !== signatureHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/**
 * Parse inbound Cloud API webhook payload into normalized messages.
 * mediaRefs use prefix meta:{media_id} for later download.
 */
function parseInboundWebhook(body) {
  const messages = [];
  if (!body || body.object !== 'whatsapp_business_account') return messages;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};

      for (const msg of value.messages || []) {
        const phone = normalizePhone(msg.from);
        let text = '';

        if (msg.type === 'text') {
          text = msg.text?.body || '';
        } else if (msg.type === 'button') {
          text = msg.button?.text || msg.button?.payload || '';
        } else if (msg.type === 'interactive') {
          text =
            msg.interactive?.button_reply?.title ||
            msg.interactive?.button_reply?.id ||
            msg.interactive?.list_reply?.title ||
            msg.interactive?.list_reply?.id ||
            '';
        } else if (msg.type === 'image') {
          text = msg.image?.caption || '';
        } else if (msg.type === 'document') {
          text = msg.document?.caption || msg.document?.filename || '';
        }

        const mediaRefs = [];
        if (msg.image?.id) mediaRefs.push(`meta:${msg.image.id}`);
        if (msg.document?.id) mediaRefs.push(`meta:${msg.document.id}`);

        messages.push({
          messageId: msg.id,
          phone,
          text,
          mediaRefs,
          type: msg.type,
        });
      }
    }
  }

  return messages;
}

async function graphRequest(path, options = {}) {
  const token = getAccessToken();
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');

  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || res.statusText || 'Graph API error';
    const err = new Error(`WhatsApp Graph API ${res.status}: ${errMsg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Send a WhatsApp message (text, or document with optional caption).
 * @param {string} toPhone - E.164 e.g. "+26771234567"
 * @param {string} body - message text / caption
 * @param {string} [mediaUrl] - public HTTPS URL for PDF/document attachment
 */
async function sendWhatsApp(toPhone, body, mediaUrl) {
  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured');

  const to = toWhatsAppId(toPhone);
  let payload;

  if (mediaUrl) {
    const filename = mediaUrl.split('/').pop()?.split('?')[0] || 'document.pdf';
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: {
        link: mediaUrl,
        caption: body || undefined,
        filename,
      },
    };
  } else {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: body || '' },
    };
  }

  return graphRequest(`/${phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Download inbound media for KYC attachments.
 * @param {string} ref - meta:{media_id} from webhook, or raw media id
 */
async function downloadWhatsAppMedia(ref) {
  const token = getAccessToken();
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');

  let mediaId = String(ref || '').trim();
  if (mediaId.startsWith('meta:')) mediaId = mediaId.slice(5);
  if (!mediaId) throw new Error('Missing media id');

  const meta = await graphRequest(`/${mediaId}`, { method: 'GET' });
  const mediaUrl = meta.url;
  if (!mediaUrl) throw new Error('Media URL missing from Graph API');

  const fileRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Failed to download WhatsApp media (${fileRes.status})`);
  }

  const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const ext = contentType.includes('pdf')
    ? 'pdf'
    : contentType.includes('png')
      ? 'png'
      : contentType.includes('webp')
        ? 'webp'
        : 'jpg';

  return { base64, contentType, filename: `document-${Date.now()}.${ext}` };
}

module.exports = {
  GRAPH_API_VERSION,
  isMetaWhatsAppConfigured,
  handleVerifyChallenge,
  verifyWebhookSignature,
  parseInboundWebhook,
  normalizePhone,
  sendWhatsApp,
  downloadWhatsAppMedia,
};
