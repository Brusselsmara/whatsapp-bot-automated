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
async function notifyUser(phone, { type, title, body, actionUrl }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Invalid phone for notification');

  const { data, error } = await supabase
    .from('user_notifications')
    .insert({
      phone: normalized,
      type: type || 'general',
      title: stripMarkdown(title),
      body: stripMarkdown(body),
      action_url: actionUrl || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create notification: ${error.message}`);
  console.log(`[NOTIFY] ${type} → ${normalized} (${data.id})`);
  return data;
}

async function listNotifications(phone, { limit = 50, unreadOnly = false } = {}) {
  const normalized = normalizePhone(phone);
  let query = supabase
    .from('user_notifications')
    .select('id, type, title, body, action_url, read_at, created_at')
    .eq('phone', normalized)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.is('read_at', null);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function countUnreadNotifications(phone) {
  const normalized = normalizePhone(phone);
  const { count, error } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('phone', normalized)
    .is('read_at', null);

  if (error) throw new Error(error.message);
  return count || 0;
}

async function markNotificationRead(phone, notificationId) {
  const normalized = normalizePhone(phone);
  const { data, error } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('phone', normalized)
    .is('read_at', null)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return !!data;
}

async function markAllNotificationsRead(phone) {
  const normalized = normalizePhone(phone);
  const { error } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('phone', normalized)
    .is('read_at', null);

  if (error) throw new Error(error.message);
}

module.exports = {
  normalizePhone,
  stripMarkdown,
  notifyUser,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
