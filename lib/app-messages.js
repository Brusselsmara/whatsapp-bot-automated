const { supabase } = require('./db');
const { resolveStoredPhone } = require('./notifications');

/**
 * Queue a bot message for the Romela Pula PWA chat (not the bell inbox).
 */
async function enqueueAppMessage(phone, { text, actionUrl, actionLabel }) {
  const storedPhone = await resolveStoredPhone(phone);

  const { data, error } = await supabase
    .from('app_messages')
    .insert({
      phone: storedPhone,
      text: String(text || '').trim(),
      action_url: actionUrl || null,
      action_label: actionLabel || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to enqueue app message: ${error.message}`);
  console.log(`[APP_MSG] → ${storedPhone} (${data.id})`);
  return data;
}

async function listUndeliveredAppMessages(phone, { limit = 20 } = {}) {
  let storedPhone;
  try {
    storedPhone = await resolveStoredPhone(phone);
  } catch {
    return [];
  }

  const { data, error } = await supabase
    .from('app_messages')
    .select('id, text, action_url, action_label, created_at')
    .eq('phone', storedPhone)
    .is('delivered_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data || [];
}

async function ackAppMessages(phone, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;

  let storedPhone;
  try {
    storedPhone = await resolveStoredPhone(phone);
  } catch {
    return 0;
  }

  const { data, error } = await supabase
    .from('app_messages')
    .update({ delivered_at: new Date().toISOString() })
    .eq('phone', storedPhone)
    .is('delivered_at', null)
    .in('id', ids)
    .select('id');

  if (error) throw new Error(error.message);
  return data?.length || 0;
}

function formatSendFailedAppMessage({ amount, currency, recipientName, ycStatus }) {
  const status = String(ycStatus || 'FAILED').toUpperCase();
  const failWord = status === 'FAILED' ? 'declined' : status.toLowerCase();
  const title = status === 'FAILED' ? 'Transfer declined' : 'Transfer failed';
  return {
    text:
      `*${title}*\n\n` +
      `Your transfer of ${amount} ${currency} to ${recipientName || 'recipient'} was ${failWord}. ` +
      `Your balance has been refunded.`,
  };
}

module.exports = {
  enqueueAppMessage,
  listUndeliveredAppMessages,
  ackAppMessages,
  formatSendFailedAppMessage,
};
