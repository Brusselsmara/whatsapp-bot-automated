const { supabase } = require('./db');
const { getPublicAppUrl } = require('./app-url');

/** WhatsApp customer service window — 24 hours after the customer's last inbound message. */
const CSW_MS = 24 * 60 * 60 * 1000;

const PWA_ACTIVATE_KEYWORDS = new Set(['app', 'pwa', 'web', 'activate', 'install']);

class PwaTwilioGateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/^whatsapp:/i, '').trim();
  if (!raw) return '';
  return raw.startsWith('+') ? raw : `+${raw}`;
}

function isPwaActivationKeyword(text) {
  const key = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return PWA_ACTIVATE_KEYWORDS.has(key);
}

function isCustomerServiceWindowOpen(lastInboundAt) {
  if (!lastInboundAt) return false;
  const ts = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < CSW_MS;
}

function cswExpiresAt(lastInboundAt) {
  if (!lastInboundAt) return null;
  const ts = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts + CSW_MS).toISOString();
}

async function getUserCswFields(phone) {
  const normalized = normalizePhone(phone);
  const { data } = await supabase
    .from('users')
    .select('phone, pwa_activated_at, last_whatsapp_inbound_at')
    .eq('phone', normalized)
    .maybeSingle();
  return data;
}

/** Call on every inbound Twilio WhatsApp message — refreshes the 24-hour CSW. */
async function recordWhatsAppInbound(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;

  const now = new Date().toISOString();
  await supabase
    .from('users')
    .upsert({ phone: normalized, last_whatsapp_inbound_at: now }, { onConflict: 'phone' });
}

/** Customer-initiated PWA activation (reply *app* on WhatsApp). */
async function activatePwa(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;

  const now = new Date().toISOString();
  await supabase
    .from('users')
    .upsert(
      {
        phone: normalized,
        pwa_activated_at: now,
        last_whatsapp_inbound_at: now,
      },
      { onConflict: 'phone' }
    );
}

async function getPwaAccessStatus(phone) {
  const row = await getUserCswFields(phone);
  const lastInboundAt = row?.last_whatsapp_inbound_at || null;
  const activated = !!row?.pwa_activated_at;
  const cswOpen = isCustomerServiceWindowOpen(lastInboundAt);

  return {
    activated,
    cswOpen,
    lastWhatsAppInboundAt: lastInboundAt,
    cswExpiresAt: cswExpiresAt(lastInboundAt),
    canSendPwaOtp: activated && cswOpen,
  };
}

/**
 * PWA login OTP is the only PWA path that uses Twilio.
 * Allowed only after customer activated via WhatsApp AND CSW is still open.
 */
async function assertPwaTwilioAllowed(phone) {
  const status = await getPwaAccessStatus(phone);

  if (!status.activated) {
    throw new PwaTwilioGateError(
      'PWA_NOT_ACTIVATED',
      'Message PayLink on WhatsApp and reply *app* to activate the web app first.'
    );
  }

  if (!status.cswOpen) {
    throw new PwaTwilioGateError(
      'CSW_CLOSED',
      'Your WhatsApp session has expired. Message PayLink on WhatsApp again (reply *app*), then sign in within 24 hours.'
    );
  }

  return status;
}

function buildPwaActivationReply() {
  const url = getPublicAppUrl();
  if (!url) {
    return (
      'PayLink web app is not configured yet (PUBLIC_APP_URL missing). ' +
      'Please contact support.'
    );
  }

  return (
    `✅ *PayLink app activated*\n\n` +
    `Open this link on your phone within the next *24 hours*:\n${url}/\n\n` +
    `Sign in with this WhatsApp number — we'll send your login code here.\n\n` +
    `After 24 hours without messaging us, reply *app* again to refresh access.\n\n` +
    `Reply *menu* for WhatsApp banking.`
  );
}

/**
 * PWA in-app chat: never activates access (WhatsApp only).
 * Unregistered users are directed to WhatsApp; registered users with expired CSW get a refresh hint.
 */
async function buildPwaActivationHintForApp(phone, user) {
  const status = await getPwaAccessStatus(phone);
  const registered = user?.kyc_status === 'approved';

  if (!registered || !status.activated) {
    return (
      `PayLink web app access is activated from *WhatsApp* only.\n\n` +
      `Open WhatsApp, message PayLink, and reply *app*. Then return here to sign in within 24 hours.\n\n` +
      `Reply *menu* to continue.`
    );
  }

  if (!status.cswOpen) {
    return (
      `Your WhatsApp session has expired. Message PayLink on WhatsApp again (reply *app*), ` +
      `then sign in here within 24 hours.\n\n` +
      `Reply *menu* for your account options.`
    );
  }

  return `You're already signed in to the PayLink app. Reply *menu* for options.`;
}

module.exports = {
  CSW_MS,
  PwaTwilioGateError,
  isPwaActivationKeyword,
  isCustomerServiceWindowOpen,
  recordWhatsAppInbound,
  activatePwa,
  getPwaAccessStatus,
  assertPwaTwilioAllowed,
  buildPwaActivationReply,
  buildPwaActivationHintForApp,
};
