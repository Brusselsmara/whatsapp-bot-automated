const API = '/api/app';

const loginView = document.getElementById('loginView');
const chatView = document.getElementById('chatView');
const loginForm = document.getElementById('loginForm');
const verifyForm = document.getElementById('verifyForm');
const chatForm = document.getElementById('chatForm');
const messagesInner = document.getElementById('messagesInner');
const messagesEl = document.getElementById('messages');
const quickRepliesEl = document.getElementById('quickReplies');
const loginError = document.getElementById('loginError');
const activationNotice = document.getElementById('activationNotice');
const logoutBtn = document.getElementById('logoutBtn');
const notificationsBtn = document.getElementById('notificationsBtn');
const notificationsPanel = document.getElementById('notificationsPanel');
const notificationsList = document.getElementById('notificationsList');
const notificationsEmpty = document.getElementById('notificationsEmpty');
const notifBadge = document.getElementById('notifBadge');
const markAllReadBtn = document.getElementById('markAllReadBtn');
const statusBar = document.getElementById('statusBar');
const walletStrip = document.getElementById('walletStrip');
const fileInput = document.getElementById('fileInput');
const messageInput = document.getElementById('message');
const sendBtn = chatForm?.querySelector('.send-btn');

let otpToken = null;
let pendingPhone = null;
let chatSessionState = null;
let notifPollTimer = null;
let settlementTimer = null;
let sending = false;
let seenNotifIds = new Set();
let seenMessageIds = new Set();
let notifsSeeded = false;
const SETTLEMENT_POLL_MS = 5000;
const SETTLEMENT_POLL_MAX_MS = 15 * 60 * 1000;
let settlementPollStartedAt = 0;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '0.00';
  return `${n.toFixed(2)} ${currency || ''}`.trim();
}

function updateNotifBadge(count) {
  const n = Number(count) || 0;
  if (n > 0) {
    notifBadge.textContent = String(n > 99 ? '99+' : n);
    notifBadge.classList.remove('hidden');
  } else {
    notifBadge.classList.add('hidden');
  }
}

function formatNotifTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '';
  }
}

function updateWalletStrip(data) {
  const wallet = data?.wallet;
  if (!wallet?.currency) {
    walletStrip.classList.add('hidden');
    walletStrip.innerHTML = '';
    return;
  }
  walletStrip.classList.remove('hidden');
  walletStrip.innerHTML =
    '<span class="wallet-icon" aria-hidden="true">💰</span>' +
    `<span class="wallet-pill"><strong>${escapeHtml(wallet.currency)}</strong>` +
    `<span>${formatMoney(wallet.balance, wallet.currency)}</span></span>`;
}

function renderNotificationsList(items) {
  notificationsList.innerHTML = '';
  if (!items.length) {
    notificationsEmpty.classList.remove('hidden');
    return;
  }
  notificationsEmpty.classList.add('hidden');
  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `notification-item${item.read_at ? '' : ' unread'}`;
    btn.innerHTML =
      `<h3>${escapeHtml(item.title)}</h3>` +
      `<p>${escapeHtml(item.body)}</p>` +
      `<time>${formatNotifTime(item.created_at)}</time>`;
    btn.addEventListener('click', () => openNotification(item));
    notificationsList.appendChild(btn);
  });
}

function addNotificationBubble(item) {
  const text = `🔔 *${item.title}*\n${item.body}`;
  addBubble(text, 'bot', { scroll: true });
}

function trackNewNotifications(items, { announce = false } = {}) {
  const list = items || [];
  if (!notifsSeeded) {
    list.forEach((n) => seenNotifIds.add(n.id));
    notifsSeeded = true;
    return;
  }
  if (!announce) return;
  const actionable = new Set(['topup_failed', 'topup_complete']);
  for (const item of list) {
    if (seenNotifIds.has(item.id)) continue;
    seenNotifIds.add(item.id);
    if (actionable.has(item.type)) addNotificationBubble(item);
  }
}

function displayAppMessages(messages, { scroll = true } = {}) {
  const toAck = [];
  for (const msg of messages || []) {
    if (seenMessageIds.has(msg.id)) continue;
    seenMessageIds.add(msg.id);
    addBubble(msg.text, 'bot', {
      scroll,
      actionUrl: msg.action_url,
      actionLabel: msg.action_label,
    });
    toAck.push(msg.id);
  }
  return toAck;
}

async function ackAppMessages(ids) {
  if (!ids.length) return;
  await api('', { method: 'POST', body: { action: 'ack-messages', ids } }).catch(() => {});
}

async function syncAppState({ announceNotifications = false } = {}) {
  const data = await api('?action=sync');
  updateStatus(data);
  updateNotifBadge(data.unreadCount);
  renderNotificationsList(data.notifications || []);
  trackNewNotifications(data.notifications, { announce: announceNotifications });
  const ackIds = displayAppMessages(data.messages, { scroll: true });
  await ackAppMessages(ackIds);
  maybeStartSettlementPolling(data.pendingCount);
  return data;
}

function stopSettlementPolling() {
  if (settlementTimer) clearInterval(settlementTimer);
  settlementTimer = null;
  settlementPollStartedAt = 0;
}

function maybeStartSettlementPolling(pendingCount) {
  if (!pendingCount) {
    stopSettlementPolling();
    return;
  }
  if (settlementTimer) return;
  settlementPollStartedAt = Date.now();
  settlementTimer = setInterval(async () => {
    if (Date.now() - settlementPollStartedAt > SETTLEMENT_POLL_MAX_MS) {
      stopSettlementPolling();
      return;
    }
    try {
      const data = await syncAppState({ announceNotifications: true });
      if (!data.pendingCount) stopSettlementPolling();
    } catch {
      stopSettlementPolling();
    }
  }, SETTLEMENT_POLL_MS);
}

async function refreshNotifications() {
  try {
    await syncAppState({ announceNotifications: false });
  } catch {
    /* logged out or offline */
  }
}

async function openNotification(item) {
  if (!item.read_at) {
    await api('', { method: 'POST', body: { action: 'mark-notification-read', id: item.id } });
  }
  if (item.action_url) window.open(item.action_url, '_blank', 'noopener');
  await refreshNotifications();
}

function startNotificationPolling() {
  stopNotificationPolling();
  syncAppState({ announceNotifications: false }).catch(() => {});
  notifPollTimer = setInterval(() => refreshNotifications(), 60000);
}

function stopNotificationPolling() {
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = null;
}

function setChatSessionState(session) {
  chatSessionState = session?.state || null;
}

function resizeComposer() {
  if (!messageInput) return;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
}

function focusComposer() {
  if (!messageInput) return;
  try {
    messageInput.focus({ preventScroll: true });
  } catch {
    messageInput.focus();
  }
}

function userFacingClientError(msg) {
  const text = String(msg || '');
  if (/yellow\s*card|yellowcard|yc\s+api/i.test(text)) {
    return 'Something went wrong. Please try again.';
  }
  return text || 'Something went wrong.';
}

function scrollMessagesToEnd() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  });
}

function afterChatUpdate({ focusInput = true } = {}) {
  scrollMessagesToEnd();
  resizeComposer();
  const docUpload = chatSessionState === 'register_documents';
  if (focusInput && !docUpload) {
    focusComposer();
  } else if (docUpload) {
    messageInput.blur();
  }
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function clearError() {
  loginError.textContent = '';
  loginError.classList.add('hidden');
  activationNotice.textContent = '';
  activationNotice.classList.add('hidden');
}

function showActivationNotice(message) {
  activationNotice.textContent = message;
  activationNotice.classList.remove('hidden');
}

function showGateError(err) {
  showError(err.message);
  if (err.data?.code === 'PWA_NOT_ACTIVATED') {
    showActivationNotice(
      'Step 1: Open WhatsApp and message PayLink. Step 2: Reply app. Step 3: Return here and tap Send code.'
    );
  } else if (err.data?.code === 'CSW_CLOSED') {
    showActivationNotice(
      'Your 24-hour WhatsApp session expired. Message PayLink on WhatsApp again (reply app), then sign in here.'
    );
  }
}

function formatBotHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

function showTypingIndicator() {
  hideTypingIndicator();
  const row = document.createElement('div');
  row.className = 'bubble-row bot';
  row.id = 'typingIndicator';
  row.innerHTML =
    '<div class="typing-indicator" aria-label="PayLink is typing">' +
    '<span></span><span></span><span></span></div>';
  messagesInner.appendChild(row);
  scrollMessagesToEnd();
}

function hideTypingIndicator() {
  document.getElementById('typingIndicator')?.remove();
}

function addBubble(text, role, { scroll = role === 'bot', actionUrl, actionLabel } = {}) {
  const row = document.createElement('div');
  row.className = `bubble-row ${role}`;
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (role === 'bot') {
    div.innerHTML = formatBotHtml(text);
    if (actionUrl) {
      div.appendChild(document.createElement('br'));
      const link = document.createElement('a');
      link.href = actionUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'bubble-link';
      link.textContent = actionLabel || 'Open link';
      div.appendChild(link);
    }
  } else {
    div.textContent = text;
  }
  row.appendChild(div);
  messagesInner.appendChild(row);
  if (scroll) scrollMessagesToEnd();
}

function setSending(busy) {
  sending = busy;
  if (sendBtn) sendBtn.disabled = busy;
  if (messageInput) messageInput.disabled = busy;
  if (busy) showTypingIndicator();
  else hideTypingIndicator();
}

function renderQuickReplies(replies, session) {
  quickRepliesEl.innerHTML = '';
  if (session?.state === 'register_documents' || chatSessionState === 'register_documents') return;
  (replies || []).forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = `${item.value}. ${item.label}`;
    btn.addEventListener('click', () => sendMessage(item.value));
    quickRepliesEl.appendChild(btn);
  });
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData
      ? undefined
      : { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body instanceof FormData
      ? options.body
      : options.body != null
        ? JSON.stringify(options.body)
        : undefined,
  });

  let data = {};
  try { data = await res.json(); } catch { /* empty */ }

  if (!res.ok) {
    const err = new Error(userFacingClientError(data.error || `Request failed (${res.status})`));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showChat() {
  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
  notificationsBtn.classList.remove('hidden');
  document.documentElement.classList.add('chat-active');
  document.body.classList.add('chat-active');
  startNotificationPolling();
}

function showLogin() {
  chatView.classList.add('hidden');
  loginView.classList.remove('hidden');
  logoutBtn.classList.add('hidden');
  notificationsBtn.classList.add('hidden');
  notificationsPanel.classList.add('hidden');
  document.documentElement.classList.remove('chat-active');
  document.body.classList.remove('chat-active');
  stopNotificationPolling();
  stopSettlementPolling();
  messagesInner.innerHTML = '';
  quickRepliesEl.innerHTML = '';
  chatSessionState = null;
  seenNotifIds = new Set();
  seenMessageIds = new Set();
  notifsSeeded = false;
  updateNotifBadge(0);
  walletStrip.classList.add('hidden');
  walletStrip.innerHTML = '';
}

async function bootstrap() {
  try {
    const data = await api('?action=me');
    showChat();
    updateStatus(data);
    addBubble('Welcome back to PayLink. Type "menu" to see options.', 'bot');
    focusComposer();
  } catch (err) {
    if (err.status !== 401) showError(err.message);
    showLogin();
  }
}

function updateStatus(data) {
  setChatSessionState(data?.session);
  updateWalletStrip(data);
  if (data?.user?.kycStatus === 'pending_review') {
    statusBar.textContent =
      'Your registration is under review — we will notify you in the PayLink app, usually within 1 business day.';
    statusBar.classList.remove('hidden');
  } else {
    statusBar.classList.add('hidden');
  }
  if (typeof data?.unreadCount === 'number') updateNotifBadge(data.unreadCount);
  if (typeof data?.pendingCount === 'number') maybeStartSettlementPolling(data.pendingCount);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const phone = document.getElementById('phone').value.trim();
  try {
    const data = await api('', {
      method: 'POST',
      body: { action: 'login', phone },
    });
    otpToken = data.otpToken;
    pendingPhone = data.phone;
    document.getElementById('verifyPhone').textContent = pendingPhone;
    loginForm.classList.add('hidden');
    verifyForm.classList.remove('hidden');
    if (data.devCode) {
      showError(`Dev mode code: ${data.devCode}`);
    }
  } catch (err) {
    showGateError(err);
  }
});

document.getElementById('phone').addEventListener('blur', async (e) => {
  const phone = e.target.value.trim();
  if (!phone) return;
  try {
    const data = await api(`?action=activation-status&phone=${encodeURIComponent(phone)}`);
    if (data.pwaAccess?.canSendPwaOtp) {
      showActivationNotice('WhatsApp app access is active — you can request a login code.');
    } else if (!data.pwaAccess?.activated) {
      showActivationNotice('Reply app on WhatsApp first to activate the PayLink web app.');
    } else if (!data.pwaAccess?.cswOpen) {
      showActivationNotice('Message PayLink on WhatsApp again (reply app) to refresh your 24-hour access.');
    }
  } catch {
    /* ignore lookup errors while typing */
  }
});

document.getElementById('backToPhone').addEventListener('click', () => {
  verifyForm.classList.add('hidden');
  loginForm.classList.remove('hidden');
  clearError();
});

verifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const code = document.getElementById('code').value.trim();
  try {
    const data = await api('', {
      method: 'POST',
      body: { action: 'verify', phone: pendingPhone, code, otpToken },
    });
    showChat();
    updateStatus(data);
    addBubble('Welcome to PayLink 👋\n\nType "menu" or tap a quick reply to get started.', 'bot');
    focusComposer();
  } catch (err) {
    showError(err.message);
  }
});

async function sendMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || sending) return;
  addBubble(trimmed, 'user', { scroll: true });
  messageInput.value = '';
  resizeComposer();
  quickRepliesEl.innerHTML = '';
  setSending(true);

  try {
    const data = await api('', {
      method: 'POST',
      body: { action: 'message', text: trimmed },
    });
    setChatSessionState(data.session);
    if (data.reply) addBubble(data.reply, 'bot', { scroll: true });
    renderQuickReplies(data.quickReplies, data.session);
    updateStatus(data);
    if (typeof data.unreadCount === 'number') updateNotifBadge(data.unreadCount);
    await syncAppState({ announceNotifications: true });
  } catch (err) {
    addBubble(userFacingClientError(err.message), 'bot', { scroll: true });
  } finally {
    setSending(false);
    afterChatUpdate({ focusInput: chatSessionState !== 'register_documents' });
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendMessage(messageInput.value);
});

messageInput.addEventListener('input', resizeComposer);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || sending) return;

  addBubble(`📎 Uploaded ${file.name}`, 'user', { scroll: true });
  quickRepliesEl.innerHTML = '';
  messageInput.blur();
  setSending(true);
  const form = new FormData();
  form.append('file', file);

  try {
    const data = await api('', { method: 'POST', body: form });
    setChatSessionState(data.session);
    if (data.reply) addBubble(data.reply, 'bot', { scroll: true });
    renderQuickReplies(data.quickReplies, data.session);
    updateStatus(data);
    if (typeof data.unreadCount === 'number') updateNotifBadge(data.unreadCount);
    await syncAppState({ announceNotifications: true });
  } catch (err) {
    addBubble(userFacingClientError(err.message) || 'Upload failed.', 'bot', { scroll: true });
  } finally {
    setSending(false);
    afterChatUpdate({ focusInput: false });
  }
});

notificationsBtn.addEventListener('click', async () => {
  const hidden = notificationsPanel.classList.toggle('hidden');
  if (!hidden) await refreshNotifications();
});

markAllReadBtn.addEventListener('click', async () => {
  await api('', { method: 'POST', body: { action: 'mark-all-notifications-read' } });
  await refreshNotifications();
});

logoutBtn.addEventListener('click', async () => {
  await api('', { method: 'POST', body: { action: 'logout' } }).catch(() => {});
  otpToken = null;
  pendingPhone = null;
  showLogin();
});

bootstrap();
