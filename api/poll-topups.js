const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const yc = require('../lib/yellowcard');

/**
 * GET /api/poll-topups
 * Polls Yellow Card for all unsettled topups and sends across ALL users.
 * Can be triggered manually or by an external cron service (e.g. cron-job.org).
 * Protected by CRON_SECRET env var.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const { data: pending, error } = await supabase
      .from('transactions')
      .select('*')
      .in('status', ['created', 'pending', 'processing'])
      .in('type', ['topup', 'send', 'invoice_payment'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error('[POLL] Query error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!pending || pending.length === 0) {
      return res.status(200).json({ polled: 0, message: 'Nothing pending' });
    }

    console.log(`[POLL] Checking ${pending.length} transaction(s)`);

    const results = await Promise.allSettled(
      pending.map((txn) => pollOne(txn))
    );

    const summary = results.map((r, i) => ({
      id: pending[i].id,
      ref: pending[i].yellowcard_reference,
      result: r.status === 'fulfilled' ? r.value : `error: ${r.reason?.message}`,
    }));

    console.log('[POLL] Done:', JSON.stringify(summary));
    return res.status(200).json({ polled: pending.length, summary });
  } catch (err) {
    console.error('[POLL] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function pollOne(txn) {
  const ref = txn.yellowcard_reference;
  if (!ref) return 'no_reference';

  let ycData;
  try {
    ycData = txn.type === 'topup'
      ? await yc.getReceive(ref)
      : await yc.getSend(ref);
  } catch (err) {
    console.error(`[POLL] Fetch failed for ${txn.id}:`, err.message);
    return `fetch_error: ${err.message}`;
  }

  const ycStatus = (ycData?.status || '').toUpperCase();
  console.log(`[POLL] txn=${txn.id} type=${txn.type} ycStatus=${ycStatus}`);

  const COMPLETE = ['COMPLETE', 'COMPLETED', 'SUCCESS'];
  const FAILED = ['FAILED', 'EXPIRED', 'CANCELLED'];

  if (COMPLETE.includes(ycStatus)) {
    return txn.type === 'topup'
      ? creditWallet(txn, ycData)
      : completeSend(txn, ycData);
  }

  if (FAILED.includes(ycStatus)) {
    return txn.type === 'topup'
      ? failTopup(txn, ycData, ycStatus)
      : failSend(txn, ycData);
  }

  return `still_${ycStatus.toLowerCase() || 'pending'}`;
}

async function creditWallet(txn, ycData) {
  // Idempotency guard
  const { data: fresh } = await supabase
    .from('transactions').select('status').eq('id', txn.id).single();
  if (fresh?.status === 'completed') return 'already_completed';

  await supabase.from('transactions')
    .update({ status: 'completed', updated_at: new Date().toISOString(), raw_response: ycData })
    .eq('id', txn.id);

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
    console.error(`[POLL] Wallet upsert failed for ${txn.id}:`, error.message, error.details);
    return `upsert_failed: ${error.message}`;
  }

  console.log(`[POLL] ✅ Credited ${txn.amount} ${txn.currency} — ${prev} → ${next}`);
  await sendWhatsApp(txn.phone,
    `✅ Top-up confirmed!\n\n*${txn.amount} ${txn.currency}* added to your wallet.\nNew balance: *${next} ${txn.currency}*\n\nReply *menu* to continue.`);

  return `credited: ${prev} → ${next}`;
}

async function failTopup(txn, ycData, ycStatus) {
  const { data: fresh } = await supabase
    .from('transactions').select('status').eq('id', txn.id).single();
  if (fresh?.status === 'failed') return 'already_failed';

  await supabase.from('transactions')
    .update({ status: 'failed', updated_at: new Date().toISOString(), raw_response: ycData })
    .eq('id', txn.id);

  await sendWhatsApp(txn.phone,
    `⚠️ Your top-up of *${txn.amount} ${txn.currency}* could not be completed. Please reply *menu* to try again.`);
  return `failed: ${ycStatus}`;
}

async function completeSend(txn, ycData) {
  const { data: fresh } = await supabase
    .from('transactions').select('status, receipt_sent').eq('id', txn.id).single();
  if (fresh?.status === 'completed') return 'already_completed';

  await supabase.from('transactions')
    .update({ status: 'completed', updated_at: new Date().toISOString(), raw_response: ycData })
    .eq('id', txn.id);

  if (!fresh?.receipt_sent) {
    const receiptUrl = `${process.env.PUBLIC_APP_URL}/api/receipt?id=${txn.id}`;
    const label = txn.type === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
    await sendWhatsApp(txn.phone,
      `✅ *${label} confirmed!*\n\n*${txn.amount} ${txn.currency}* sent to *${txn.recipient_name}*.\n\nYour receipt is attached.`,
      receiptUrl);
    await supabase.from('transactions').update({ receipt_sent: true }).eq('id', txn.id);
  }

  if (txn.invoice_id) {
    await supabase.from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', txn.invoice_id);
  }

  return 'send_completed';
}

async function failSend(txn, ycData) {
  const { data: fresh } = await supabase
    .from('transactions').select('status').eq('id', txn.id).single();
  if (fresh?.status === 'failed') return 'already_failed';

  await supabase.from('transactions')
    .update({ status: 'failed', updated_at: new Date().toISOString(), raw_response: ycData })
    .eq('id', txn.id);

  // Refund
  const { data: wallet } = await supabase
    .from('wallets').select('balance')
    .eq('phone', txn.phone).eq('currency', txn.currency).single();
  const prev = parseFloat(wallet?.balance ?? 0);
  const refunded = parseFloat((prev + parseFloat(txn.amount)).toFixed(2));

  const { error } = await supabase.from('wallets').upsert(
    { phone: txn.phone, currency: txn.currency, balance: refunded, updated_at: new Date().toISOString() },
    { onConflict: 'phone,currency' }
  );
  if (error) console.error(`[POLL] Refund upsert failed for ${txn.id}:`, error.message);
  else {
    console.log(`[POLL] ↩️ Refunded ${txn.amount} ${txn.currency} — ${prev} → ${refunded}`);
    await sendWhatsApp(txn.phone,
      `⚠️ Your transfer of *${txn.amount} ${txn.currency}* to ${txn.recipient_name} failed. Your balance has been refunded.`);
  }
  return 'send_failed_refunded';
}