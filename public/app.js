const API = '/api/app';

const loginView = document.getElementById('loginView');
const chatView = document.getElementById('chatView');
const loginForm = document.getElementById('loginForm');
const verifyForm = document.getElementById('verifyForm');
const chatForm = document.getElementById('chatForm');
const messagesEl = document.getElementById('messages');
const quickRepliesEl = document.getElementById('quickReplies');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');
const statusBar = document.getElementById('statusBar');
const fileInput = document.getElementById('fileInput');

let otpToken = null;
let pendingPhone = null;

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function clearError() {
  loginError.textContent = '';
  loginError.classList.add('hidden');
}

function formatBotText(text) {
  return String(text || '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function addBubble(text, role) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = formatBotText(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderQuickReplies(replies) {
  quickRepliesEl.innerHTML = '';
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
}

function showLogin() {
  chatView.classList.add('hidden');
  loginView.classList.remove('hidden');
  logoutBtn.classList.add('hidden');
  messagesEl.innerHTML = '';
  quickRepliesEl.innerHTML = '';
}

async function bootstrap() {
  try {
    const data = await api('?action=me');
    showChat();
    updateStatus(data);
    addBubble('Welcome back to PayLink. Type "menu" to see options.', 'bot');
  } catch (err) {
    if (err.status !== 401) showError(err.message);
    showLogin();
  }
}

function updateStatus(data) {
  if (data?.user?.kycStatus === 'pending_review') {
    statusBar.textContent = 'Your registration is under review — usually within 1 business day.';
    statusBar.classList.remove('hidden');
  } else {
    statusBar.classList.add('hidden');
  }
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
    showError(err.message);
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
  } catch (err) {
    showError(err.message);
  }
});

async function sendMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  addBubble(trimmed, 'user');
  document.getElementById('message').value = '';
  quickRepliesEl.innerHTML = '';

  try {
    const data = await api('', {
      method: 'POST',
      body: { action: 'message', text: trimmed },
    });
    if (data.reply) addBubble(data.reply, 'bot');
    renderQuickReplies(data.quickReplies);
    updateStatus(data);
  } catch (err) {
    addBubble(err.message || 'Something went wrong.', 'bot');
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('message');
  await sendMessage(input.value);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;

  addBubble(`📎 Uploaded ${file.name}`, 'user');
  const form = new FormData();
  form.append('file', file);

  try {
    const data = await api('', { method: 'POST', body: form });
    if (data.reply) addBubble(data.reply, 'bot');
    renderQuickReplies(data.quickReplies);
  } catch (err) {
    addBubble(err.message || 'Upload failed.', 'bot');
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('', { method: 'POST', body: { action: 'logout' } }).catch(() => {});
  otpToken = null;
  pendingPhone = null;
  showLogin();
});

bootstrap();
