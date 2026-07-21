const { handleIncomingMessage, getSession, getOrCreateUser, settlePending, getSettlementPendingCount, beginInvoicePayment } = require('../lib/conversation');
const {
  isAppAuthConfigured,
  issueOtp,
  verifyOtpToken,
  getPhoneFromSession,
  createAppSessionCookie,
  clearAppSessionCookie,
  normalizePhone,
} = require('../lib/app-auth');
const { storeWebDocument } = require('../lib/web-media');
const { parseQuickReplies } = require('../lib/app-ui');
const { captureError } = require('../lib/observability');
const { userFacingErrorMessage } = require('../lib/user-errors');
const { PwaTwilioGateError, getPwaAccessStatus } = require('../lib/customer-service-window');
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  safeCountUnreadNotifications,
} = require('../lib/notifications');
const { listUndeliveredAppMessages, ackAppMessages } = require('../lib/app-messages');
const yc = require('../lib/yellowcard');
const { supabase } = require('../lib/db');

async function loadUserWallet(phone, user) {
  const currency = user?.home_currency || user?.homeCurrency;
  if (!currency) return null;
  const { data } = await supabase
    .from('wallets')
    .select('balance, currency')
    .eq('phone', phone)
    .eq('currency', currency)
    .maybeSingle();
  const balance = data ? parseFloat(data.balance) : 0;
  return { currency, balance };
}

module.exports.config = { api: { bodyParser: false } };

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function readRawBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).end(JSON.stringify(body));
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    phone: user.phone,
    accountType: user.account_type,
    businessName: user.business_name,
    kycStatus: user.kyc_status,
    homeCurrency: user.home_currency,
    homeCountry: user.home_country,
    displayName: user.kyc_name || user.display_name,
  };
}

function parseQuickRepliesForSession(reply, session) {
  return parseQuickReplies(reply, session);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (!isAppAuthConfigured()) {
    return json(res, 503, {
      error: 'PWA auth is not configured. Set APP_SESSION_SECRET in Vercel environment variables.',
    });
  }

  try {
    if (req.method === 'GET') {
      return handleGet(req, res);
    }
    if (req.method === 'POST') {
      return handlePost(req, res);
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    captureError(err, { handler: 'app' });
    return json(res, 500, { error: userFacingErrorMessage(err, 'Something went wrong. Please try again.') });
  }
};

async function handleGet(req, res) {
  const action = req.query.action || 'me';
  if (action === 'health') {
    return json(res, 200, { ok: true, service: 'romela-pula-app' });
  }

  if (action === 'activation-status') {
    const queryPhone = normalizePhone(req.query.phone);
    if (!queryPhone) return json(res, 400, { error: 'phone query parameter required' });
    if (!yc.isSupportedWhatsAppNumber(queryPhone)) {
      return json(res, 400, { error: 'Romela Pula is not available for this country code yet.' });
    }
    const pwaAccess = await getPwaAccessStatus(queryPhone);
    return json(res, 200, { phone: queryPhone, pwaAccess });
  }

  const phone = getPhoneFromSession(req);
  if (!phone) {
    return json(res, 401, { error: 'Not logged in' });
  }

  if (action === 'me') {
    await settlePending(phone);
    const user = await getOrCreateUser(phone);
    const session = await getSession(phone);
    const pwaAccess = await getPwaAccessStatus(phone);
    const [unreadCount, pendingCount] = await Promise.all([
      safeCountUnreadNotifications(phone),
      getSettlementPendingCount(phone),
    ]);
    const wallet = await loadUserWallet(phone, user);
    return json(res, 200, {
      user: sanitizeUser(user),
      session: { state: session.state, context: session.context || {} },
      supported: yc.isSupportedWhatsAppNumber(phone),
      pwaAccess,
      unreadCount,
      pendingCount,
      wallet,
    });
  }

  if (action === 'sync' || action === 'notifications') {
    await settlePending(phone);
    const user = await getOrCreateUser(phone);
    const unreadOnly = action === 'notifications' && req.query.unread === '1';
    const [notifications, unreadCount, pendingCount, wallet, messages] = await Promise.all([
      listNotifications(phone, { unreadOnly }),
      safeCountUnreadNotifications(phone),
      getSettlementPendingCount(phone),
      loadUserWallet(phone, user),
      action === 'sync' ? listUndeliveredAppMessages(phone) : Promise.resolve([]),
    ]);
    return json(res, 200, { notifications, unreadCount, pendingCount, wallet, messages });
  }

  return json(res, 400, { error: 'Unknown action' });
}

async function handlePost(req, res) {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    return handleUpload(req, res);
  }

  const raw = await readRawBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  switch (body.action) {
    case 'login':
      return handleLogin(body, res);
    case 'verify':
      return handleVerify(body, res);
    case 'logout':
      res.setHeader('Set-Cookie', clearAppSessionCookie());
      return json(res, 200, { ok: true });
    case 'message':
      return handleMessage(body, req, res);
    case 'mark-notification-read':
      return handleMarkNotificationRead(body, req, res);
    case 'mark-all-notifications-read':
      return handleMarkAllNotificationsRead(req, res);
    case 'ack-messages':
      return handleAckMessages(body, req, res);
    case 'start-invoice-pay':
      return handleStartInvoicePay(body, req, res);
    default:
      return json(res, 400, { error: 'Unknown action' });
  }
}

async function handleLogin(body, res) {
  const phone = normalizePhone(body.phone);
  if (!phone) return json(res, 400, { error: 'Enter a valid phone number with country code, e.g. +26771234567' });
  if (!yc.isSupportedWhatsAppNumber(phone)) {
    return json(res, 400, { error: 'Romela Pula is not available for this country code yet.' });
  }

  try {
    const result = await issueOtp(phone);
    return json(res, 200, {
      ok: true,
      phone: result.phone,
      otpToken: result.otpToken,
      message: 'We sent a 6-digit code to your WhatsApp number.',
      devCode: result.devCode,
    });
  } catch (err) {
    if (err instanceof PwaTwilioGateError) {
      const pwaAccess = await getPwaAccessStatus(phone);
      return json(res, 403, {
        error: err.message,
        code: err.code,
        pwaAccess,
      });
    }
    throw err;
  }
}

async function handleVerify(body, res) {
  const phone = normalizePhone(body.phone);
  const code = String(body.code || '').trim();
  const otpToken = body.otpToken;

  if (!phone || !code || !otpToken) {
    return json(res, 400, { error: 'Phone, code, and otpToken are required.' });
  }
  if (!verifyOtpToken(phone, code, otpToken)) {
    return json(res, 401, { error: 'Invalid or expired code.' });
  }

  res.setHeader('Set-Cookie', createAppSessionCookie(phone));
  const user = await getOrCreateUser(phone);
  const session = await getSession(phone);
  const wallet = await loadUserWallet(phone, user);
  return json(res, 200, {
    ok: true,
    user: sanitizeUser(user),
    session: { state: session.state },
    unreadCount: await safeCountUnreadNotifications(phone),
    wallet,
  });
}

async function handleMessage(body, req, res) {
  const phone = getPhoneFromSession(req);
  if (!phone) return json(res, 401, { error: 'Not logged in' });

  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { error: 'Message text is required.' });

  let reply;
  try {
    reply = await handleIncomingMessage(phone, text, [], { channel: 'pwa' });
  } catch (err) {
    captureError(err, { handler: 'app_message', phone, text });
    reply = 'Sorry, something went wrong. Please type "menu" to start over.';
  }

  const user = await getOrCreateUser(phone);
  const session = await getSession(phone);
  const wallet = await loadUserWallet(phone, user);
  const pendingCount = await getSettlementPendingCount(phone);
  return json(res, 200, {
    reply,
    quickReplies: parseQuickRepliesForSession(reply, session),
    user: sanitizeUser(user),
    session: { state: session.state },
    unreadCount: await safeCountUnreadNotifications(phone),
    pendingCount,
    wallet,
  });
}

async function handleMarkNotificationRead(body, req, res) {
  const phone = getPhoneFromSession(req);
  if (!phone) return json(res, 401, { error: 'Not logged in' });

  const id = body.id;
  if (!id) return json(res, 400, { error: 'Notification id is required.' });

  const ok = await markNotificationRead(phone, id);
  if (!ok) return json(res, 404, { error: 'Notification not found.' });

  return json(res, 200, {
    ok: true,
    unreadCount: await safeCountUnreadNotifications(phone),
  });
}

async function handleMarkAllNotificationsRead(req, res) {
  const phone = getPhoneFromSession(req);
  if (!phone) return json(res, 401, { error: 'Not logged in' });

  await markAllNotificationsRead(phone);
  return json(res, 200, { ok: true, unreadCount: 0 });
}

async function handleAckMessages(body, req, res) {
  const phone = getPhoneFromSession(req);
  if (!phone) return json(res, 401, { error: 'Not logged in' });

  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  if (!ids.length) return json(res, 400, { error: 'Message ids are required.' });

  const acked = await ackAppMessages(phone, ids);
  return json(res, 200, { ok: true, acked });
}

async function handleStartInvoicePay(body, req, res) {
  const phone = getPhoneFromSession(req);
  if (!phone) return json(res, 401, { error: 'Not logged in' });

  const code = String(body.code || '').trim();
  if (!code) return json(res, 400, { error: 'Invoice code is required.' });

  const user = await getOrCreateUser(phone);
  if (user.kyc_status !== 'approved') {
    return json(res, 403, { error: 'Your account must be approved before paying invoices.' });
  }

  let reply;
  try {
    reply = await beginInvoicePayment(phone, code);
  } catch (err) {
    captureError(err, { handler: 'start_invoice_pay', phone, code });
    reply = 'Sorry, something went wrong loading this invoice. Please try again.';
  }

  const session = await getSession(phone);
  const wallet = await loadUserWallet(phone, user);
  const pendingCount = await getSettlementPendingCount(phone);

  return json(res, 200, {
    reply,
    quickReplies: parseQuickRepliesForSession(reply, session),
    user: sanitizeUser(user),
    session: { state: session.state, context: session.context || {} },
    unreadCount: await safeCountUnreadNotifications(phone),
    pendingCount,
    wallet,
  });
}

async function handleUpload(req, res) {
  const phone = getPhoneFromSession(req);
  if (!phone) return json(res, 401, { error: 'Not logged in' });

  const raw = await readRawBody(req, MAX_UPLOAD_BYTES + 4096);
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return json(res, 400, { error: 'Invalid multipart request' });

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const filePart = parseMultipartFile(raw, boundary);
  if (!filePart) return json(res, 400, { error: 'No file uploaded' });
  if (filePart.data.length > MAX_UPLOAD_BYTES) {
    return json(res, 413, { error: 'File too large (max 8 MB)' });
  }

  const base64 = filePart.data.toString('base64');
  const ref = await storeWebDocument(phone, {
    base64,
    contentType: filePart.contentType,
    filename: filePart.filename,
  });

  let reply;
  try {
    reply = await handleIncomingMessage(phone, '', [ref], { channel: 'pwa' });
  } catch (err) {
    captureError(err, { handler: 'app_upload', phone });
    reply = 'Document received but something went wrong. Please try again or type "done".';
  }

  const session = await getSession(phone);
  const user = await getOrCreateUser(phone);
  const wallet = await loadUserWallet(phone, user);
  const pendingCount = await getSettlementPendingCount(phone);
  return json(res, 200, {
    ok: true,
    ref,
    reply,
    quickReplies: parseQuickRepliesForSession(reply, session),
    session: { state: session.state },
    unreadCount: await safeCountUnreadNotifications(phone),
    pendingCount,
    wallet,
  });
}

function parseMultipartFile(raw, boundary) {
  const delim = `--${boundary}`;
  const parts = raw.split(delim);
  for (const part of parts) {
    if (!part || part === '--\r\n' || part === '--') continue;
    const chunk = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const headerBlock = chunk.slice(0, sep);
    if (!/content-disposition:\s*form-data/i.test(headerBlock)) continue;
    if (!/name="file"/i.test(headerBlock) && !/name=file/i.test(headerBlock)) continue;

    const filenameMatch = headerBlock.match(/filename="([^"]+)"/i);
    const typeMatch = headerBlock.match(/content-type:\s*([^\r\n]+)/i);
    let data = Buffer.from(chunk.slice(sep + 4), 'binary');
    if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);

    return {
      filename: filenameMatch ? filenameMatch[1] : 'document',
      contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
      data,
    };
  }
  return null;
}
