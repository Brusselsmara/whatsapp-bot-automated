const crypto = require('crypto');

const COOKIE_NAME = 'paylink_admin';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function getAdminSecret() {
  return (process.env.ADMIN_SECRET || '').trim();
}

function isAdminAuthConfigured() {
  return !!getAdminSecret();
}

function signSession(expMs) {
  const secret = getAdminSecret();
  if (!secret) return null;
  const payload = String(expMs);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  const secret = getAdminSecret();
  if (!secret || !token || typeof token !== 'string') return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = parseInt(payload, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function parseAdminCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return decodeURIComponent(trimmed.slice(COOKIE_NAME.length + 1));
    }
  }
  return null;
}

function isAdminAuthenticated(req) {
  if (!isAdminAuthConfigured()) return false;
  return verifySessionToken(parseAdminCookie(req));
}

function verifyLoginPassword(password) {
  const secret = getAdminSecret();
  if (!secret || password == null) return false;
  const a = Buffer.from(String(password));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function createSessionCookie() {
  const exp = Date.now() + SESSION_MS;
  const token = signSession(exp);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`;
}

module.exports = {
  COOKIE_NAME,
  isAdminAuthConfigured,
  isAdminAuthenticated,
  verifyLoginPassword,
  verifySessionToken,
  signSession,
  createSessionCookie,
  clearSessionCookie,
};
