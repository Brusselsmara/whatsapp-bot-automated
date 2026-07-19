const API = '/api/app';

const loginView = document.getElementById('loginView');
const chatView = document.getElementById('chatView');
const loginForm = document.getElementById('loginForm');
const verifyForm = document.getElementById('verifyForm');
const chatForm = document.getElementById('chatForm');
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
const fileInput = document.getElementById('fileInput');
const messageInput = document.getElementById('message');

let otpToken = null;
let pendingPhone = null;
let chatSessionState = null;
let notifPollTimer = null;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

async function refreshNotifications() {
  try {
    const data = await api('?action=notifications');
    updateNotifBadge(data.unreadCount);
    renderNotificationsList(data.notifications || []);
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
  refreshNotifications();
  notifPollTimer = setInterval(refreshNotifications, 60000);
}

function stopNotificationPolling() {
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = null;
}

function setChatSessionState(session) {
  chatSessionState = session?.state || null;
}

function focusComposer() {
  if (!messageInput) return;
  try {
    messageInput.focus({ preventScroll: true });
  } catch {
    messageInput.focus();
  }
}

function scrollMessagesToEnd() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
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

function formatBotText(text) {
  return String(text || '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function addBubble(text, role, { scroll = role === 'bot' } = {}) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = formatBotText(text);
  messagesEl.appendChild(div);
  if (scroll) scrollMessagesToEnd();
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
    const err = new Error(data.error || `Request failed (${res.status})`);
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
  document.body.classList.add('chat-active');
  startNotificationPolling();
}

function showLogin() {
  chatView.classList.add('hidden');
  loginView.classList.remove('hidden');
  logoutBtn.classList.add('hidden');
  notificationsBtn.classList.add('hidden');
  notificationsPanel.classList.add('hidden');
  document.body.classList.remove('chat-active');
  stopNotificationPolling();
  messagesEl.innerHTML = '';
  quickRepliesEl.innerHTML = '';
  chatSessionState = null;
  updateNotifBadge(0);
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
  if (data?.user?.kycStatus === 'pending_review') {
    statusBar.textContent =
      'Your registration is under review — we will notify you in the PayLink app, usually within 1 business day.';
    statusBar.classList.remove('hidden');
  } else {
    statusBar.classList.add('hidden');
  }
  if (typeof data?.unreadCount === 'number') updateNotifBadge(data.unreadCount);
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
  if (!trimmed) return;
  addBubble(trimmed, 'user', { scroll: true });
  messageInput.value = '';
  quickRepliesEl.innerHTML = '';
  focusComposer();

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
  } catch (err) {
    addBubble(err.message || 'Something went wrong.', 'bot', { scroll: true });
  } finally {
    focusComposer();
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendMessage(messageInput.value);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;

  addBubble(`📎 Uploaded ${file.name}`, 'user', { scroll: true });
  quickRepliesEl.innerHTML = '';
  focusComposer();
  const form = new FormData();
  form.append('file', file);

  try {
    const data = await api('', { method: 'POST', body: form });
    setChatSessionState(data.session);
    if (data.reply) addBubble(data.reply, 'bot', { scroll: true });
    renderQuickReplies(data.quickReplies, data.session);
    updateStatus(data);
    if (typeof data.unreadCount === 'number') updateNotifBadge(data.unreadCount);
  } catch (err) {
    addBubble(err.message || 'Upload failed.', 'bot', { scroll: true });
  } finally {
    focusComposer();
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
