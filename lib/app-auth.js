const crypto = require('crypto');
const { sendWhatsApp } = require('./whatsapp');
const { assertPwaTwilioAllowed } = require('./customer-service-window');

const COOKIE_NAME = 'romela_pula_app';
const OTP_MS = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function getSessionSecret() {
  return (process.env.APP_SESSION_SECRET || process.env.CRON_SECRET || '').trim();
}

function isAppAuthConfigured() {
  return !!getSessionSecret();
}

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/^whatsapp:/i, '').trim();
  if (!raw) return '';
  return raw.startsWith('+') ? raw : `+${raw}`;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function signPayload(payload) {
  const secret = getSessionSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function randomOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Start login — sends a 6-digit code via WhatsApp.
 * Returns an otpToken the client must send back with the code.
 */
async function issueOtp(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Invalid phone number');
  if (!isAppAuthConfigured()) throw new Error('APP_SESSION_SECRET is not configured');

  await assertPwaTwilioAllowed(normalized);

  const code = randomOtpCode();
  const exp = Date.now() + OTP_MS;
  const payload = `${normalized}|${hashCode(code)}|${exp}`;
  const sig = signPayload(payload);
  const otpToken = `${payload}|${sig}`;

  const message = `Your Romela Pula app login code is *${code}*. Valid for 10 minutes.`;
  try {
    await sendWhatsApp(normalized, message);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') throw err;
    console.log(`[APP] Dev OTP for ${normalized}: ${code} (${err.message})`);
  }

  const out = { otpToken, phone: normalized };
  if (process.env.NODE_ENV !== 'production') out.devCode = code;
  return out;
}

function verifyOtpToken(phone, code, otpToken) {
  const secret = getSessionSecret();
  if (!secret || !otpToken || !code) return false;

  const parts = String(otpToken).split('|');
  if (parts.length !== 4) return false;

  const [tokenPhone, codeHash, expStr, sig] = parts;
  const normalized = normalizePhone(phone);
  if (tokenPhone !== normalized) return false;

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const payload = `${tokenPhone}|${codeHash}|${expStr}`;
  const expected = signPayload(payload);
  if (!expected || sig.length !== expected.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch {
    return false;
  }

  return hashCode(code) === codeHash;
}

function signSessionPhone(phone, expMs) {
  const payload = `${normalizePhone(phone)}|${expMs}`;
  const sig = signPayload(payload);
  return `${payload}|${sig}`;
}

function verifySessionToken(token) {
  const secret = getSessionSecret();
  if (!secret || !token) return null;

  const parts = String(token).split('|');
  if (parts.length !== 3) return null;

  const [phone, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  const payload = `${phone}|${expStr}`;
  const expected = signPayload(payload);
  if (!expected || sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  return phone;
}

function parseAppCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return decodeURIComponent(trimmed.slice(COOKIE_NAME.length + 1));
    }
  }
  return null;
}

function getPhoneFromSession(req) {
  if (!isAppAuthConfigured()) return null;
  const token = parseAppCookie(req);
  return verifySessionToken(token);
}

function isAppAuthenticated(req) {
  return !!getPhoneFromSession(req);
}

function createAppSessionCookie(phone) {
  const exp = Date.now() + SESSION_MS;
  const token = signSessionPhone(phone, exp);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`;
}

function clearAppSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

module.exports = {
  COOKIE_NAME,
  normalizePhone,
  isAppAuthConfigured,
  issueOtp,
  verifyOtpToken,
  getPhoneFromSession,
  isAppAuthenticated,
  createAppSessionCookie,
  clearAppSessionCookie,
};
