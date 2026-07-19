const { supabase } = require('./db');

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/^whatsapp:/i, '').trim();
  if (!raw) return '';
  return raw.startsWith('+') ? raw : `+${raw}`;
}

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .trim();
}

/**
 * Store an in-app notification for the PayLink PWA (no WhatsApp fallback).
 */
/** Match users.phone exactly (FK) — handles + prefix inconsistencies. */
async function resolveStoredPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Invalid phone for notification');

  const { data: exact } = await supabase
    .from('users')
    .select('phone')
    .eq('phone', normalized)
    .maybeSingle();
  if (exact?.phone) return exact.phone;

  const bare = normalized.replace(/^\+/, '');
  const { data: bareRow } = await supabase
    .from('users')
    .select('phone')
    .eq('phone', bare)
    .maybeSingle();
  if (bareRow?.phone) return bareRow.phone;

  throw new Error(
    `User not found for notification (${normalized}). Ensure user_notifications migration is applied.`
  );
}

async function notifyUser(phone, { type, title, body, actionUrl }) {
  const storedPhone = await resolveStoredPhone(phone);

  const { data, error } = await supabase
    .from('user_notifications')
    .insert({
      phone: storedPhone,
      type: type || 'general',
      title: stripMarkdown(title),
      body: stripMarkdown(body),
      action_url: actionUrl || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create notification: ${error.message}`);
  console.log(`[NOTIFY] ${type} → ${storedPhone} (${data.id})`);
  return data;
}

async function safeCountUnreadNotifications(phone) {
  try {
    return await countUnreadNotifications(phone);
  } catch (err) {
    console.warn('[NOTIFY] Unread count unavailable:', err.message);
    return 0;
  }
}

async function listNotifications(phone, { limit = 50, unreadOnly = false } = {}) {
  let storedPhone;
  try {
    storedPhone = await resolveStoredPhone(phone);
  } catch {
    return [];
  }

  let query = supabase
    .from('user_notifications')
    .select('id, type, title, body, action_url, read_at, created_at')
    .eq('phone', storedPhone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.is('read_at', null);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function countUnreadNotifications(phone) {
  let storedPhone;
  try {
    storedPhone = await resolveStoredPhone(phone);
  } catch {
    return 0;
  }

  const { count, error } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('phone', storedPhone)
    .is('read_at', null);

  if (error) throw new Error(error.message);
  return count || 0;
}

async function markNotificationRead(phone, notificationId) {
  let storedPhone;
  try {
    storedPhone = await resolveStoredPhone(phone);
  } catch {
    return false;
  }

  const { data, error } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('phone', storedPhone)
    .is('read_at', null)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return !!data;
}

async function markAllNotificationsRead(phone) {
  let storedPhone;
  try {
    storedPhone = await resolveStoredPhone(phone);
  } catch {
    return;
  }

  const { error } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('phone', storedPhone)
    .is('read_at', null);

  if (error) throw new Error(error.message);
}

module.exports = {
  normalizePhone,
  stripMarkdown,
  notifyUser,
  resolveStoredPhone,
  listNotifications,
  countUnreadNotifications,
  safeCountUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
