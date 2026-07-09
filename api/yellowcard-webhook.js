const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const { verifyWebhookSignature } = require('../lib/yellowcard');

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-yc-signature'];

  if (process.env.NODE_ENV === 'production' && !verifyWebhookSignature(rawBody, signature)) {
    console.error('[WEBHOOK] Signature mismatch — rejecting');
    return res.status(403).send('Invalid signature');
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).send('Invalid JSON'); }

  console.log('[WEBHOOK] Received:', JSON.stringify(event));

  try {
    const status = mapStatus(event.event);
    const ycId = event.id || event.data?.id;
    console.log(`[WEBHOOK] event=${event.event} status=${status} ycId=${ycId}`);

    if (!ycId || !status) {
      console.warn('[WEBHOOK] Unrecognized or missing id — ignoring');
      return res.status(200).json({ received: true, note: 'ignored' });
    }

    // Look up by YC id first, then by sequenceId as fallback
    let txn = await findAndUpdateTxn(ycId, status, event);
    if (!txn) txn = await findAndUpdateTxn(event.sequenceId || '', status, event);

    if (!txn) {
      console.warn(`[WEBHOOK] No transaction found for ycId=${ycId}`);
      return res.status(200).json({ received: true, note: 'no matching transaction' });
    }

    if (txn.type === 'topup') await handleTopupUpdate(txn, status);
    else await handleSendUpdate(txn, status, event);

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK] Error:', err);
    return res.status(200).json({ received: true, error: 'logged' });
  }
};

async function findAndUpdateTxn(ycId, status, event) {
  if (!ycId) return null;
  const { data } = await supabase
    .from('transactions')
    .update({ status, updated_at: new Date().toISOString(), raw_response: event })
    .eq('yellowcard_reference', ycId)
    .select()
    .single();
  return data || null;
}

async function handleTopupUpdate(txn, status) {
  // Idempotency: don't double-credit if webhook fires twice
  if (txn.status === 'completed' && status === 'completed') {
    console.log(`[WEBHOOK] topup ${txn.id} already completed — skipping credit`);
    return;
  }

  if (status === 'completed') {
    const { data: wallet } = await supabase
      .from('wallets').select('balance')
      .eq('phone', txn.phone).eq('currency', txn.currency).single();

    const prev = parseFloat(wallet?.balance ?? 0);
    const next = parseFloat((prev + parseFloat(txn.amount)).toFixed(2));

    const { error } = await supabase.from('wallets').upsert(
      { phone: txn.phone, currency: txn.currency, balance: next, updated_at: new Date().toISOString() },
      { onConflict: 'phone,currency' }
    );
    if (error) {
      console.error(`[WEBHOOK] Wallet upsert failed for topup ${txn.id}:`, error.message);
      return;
    }
    console.log(`[WEBHOOK] ✅ Topup credited ${txn.amount} ${txn.currency} — ${prev} → ${next}`);
    await sendWhatsApp(txn.phone,
      `✅ Top-up of *${txn.amount} ${txn.currency}* confirmed!\n\nNew balance: *${next} ${txn.currency}*`);

  } else if (status === 'failed') {
    await sendWhatsApp(txn.phone,
      `⚠️ Your top-up of *${txn.amount} ${txn.currency}* failed. Please reply *menu* to try again.`);
  }
}

async function handleSendUpdate(txn, status, event) {
  if (status === 'completed') {
    if (txn.receipt_sent) {
      console.log(`[WEBHOOK] send ${txn.id} receipt already sent — skipping`);
      return;
    }
    const receiptUrl = `${process.env.PUBLIC_APP_URL}/api/receipt?id=${txn.id}`;
    const label = txn.type === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
    await sendWhatsApp(txn.phone,
      `✅ *${label} confirmed!*\n\n*${txn.amount} ${txn.currency}* sent to *${txn.recipient_name}*.\n\nYour receipt is attached.`,
      receiptUrl);
    await supabase.from('transactions').update({ receipt_sent: true }).eq('id', txn.id);

  } else if (status === 'failed') {
    if (txn.status === 'failed') return; // already refunded

    const { data: wallet } = await supabase
      .from('wallets').select('balance')
      .eq('phone', txn.phone).eq('currency', txn.currency).single();

    const prev = parseFloat(wallet?.balance ?? 0);
    const refunded = parseFloat((prev + parseFloat(txn.amount)).toFixed(2));

    const { error } = await supabase.from('wallets').upsert(
      { phone: txn.phone, currency: txn.currency, balance: refunded, updated_at: new Date().toISOString() },
      { onConflict: 'phone,currency' }
    );
    if (error) {
      console.error(`[WEBHOOK] Wallet refund failed for send ${txn.id}:`, error.message);
      return;
    }
    console.log(`[WEBHOOK] ↩️ Refunded ${txn.amount} ${txn.currency} — ${prev} → ${refunded}`);
    await sendWhatsApp(txn.phone,
      `⚠️ Your transfer of *${txn.amount} ${txn.currency}* to ${txn.recipient_name} failed. Your balance has been refunded.`);
  }
}

function mapStatus(eventName) {
  if (!eventName) return null;
  const e = eventName.toUpperCase();
  if (e.endsWith('.COMPLETE') || e.endsWith('.COMPLETED') || e.endsWith('.SUCCESS')) return 'completed';
  if (e.endsWith('.PROCESSING')) return 'processing';
  if (e.endsWith('.FAILED') || e.endsWith('.EXPIRED') || e.endsWith('.CANCELLED')) return 'failed';
  if (e.endsWith('.PENDING') || e.endsWith('.CREATED')) return 'pending';
  return null;
}