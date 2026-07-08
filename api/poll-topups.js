const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const yc = require('../lib/yellowcard');

/**
 * GET /api/poll-topups
 *
 * Vercel cron — runs every minute.
 * Finds all topup transactions still in pending/processing state,
 * polls Yellow Card for their current status, and:
 *   - COMPLETE  → credits wallet, notifies user
 *   - FAILED    → marks failed, notifies user
 *   - otherwise → leaves as-is for next poll
 *
 * Also called by the bot 10 s after momo submission so the user
 * gets fast feedback if YC resolves it quickly (sandbox).
 */
module.exports = async (req, res) => {
  // Allow Vercel cron (GET) and internal bot calls (POST)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Simple shared secret so the endpoint isn't open to the public
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    // Fetch all topups that haven't settled yet
    const { data: pending, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('type', 'topup')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error('[POLL] Supabase query error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!pending || pending.length === 0) {
      return res.status(200).json({ polled: 0, message: 'No pending topups' });
    }

    console.log(`[POLL] Checking ${pending.length} pending topup(s)...`);

    const results = await Promise.allSettled(pending.map((txn) => pollOne(txn)));

    const summary = results.map((r, i) => ({
      id: pending[i].id,
      ref: pending[i].yellowcard_reference,
      result: r.status === 'fulfilled' ? r.value : `error: ${r.reason?.message}`,
    }));

    console.log('[POLL] Results:', JSON.stringify(summary));
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
    ycData = await yc.getReceive(ref);
  } catch (err) {
    console.error(`[POLL] getReceive(${ref}) failed:`, err.message);
    return `fetch_error: ${err.message}`;
  }

  console.log(`[POLL] txn=${txn.id} ref=${ref} ycStatus=${ycData?.status}`);

  const ycStatus = (ycData?.status || '').toUpperCase();

  if (ycStatus === 'COMPLETE' || ycStatus === 'COMPLETED') {
    return creditWallet(txn, ycData);
  }

  if (ycStatus === 'FAILED' || ycStatus === 'EXPIRED' || ycStatus === 'CANCELLED') {
    await supabase
      .from('transactions')
      .update({ status: 'failed', updated_at: new Date().toISOString(), raw_response: ycData })
      .eq('id', txn.id);

    await sendWhatsApp(
      txn.phone,
      `⚠️ Your top-up of ${txn.amount} ${txn.currency} could not be completed (${ycStatus.toLowerCase()}). Please reply *menu* to try again.`,
    );
    return `failed: ${ycStatus}`;
  }

  // Still pending/processing — nothing to do yet
  return `still_${ycStatus.toLowerCase() || 'pending'}`;
}

async function creditWallet(txn, ycData) {
  // Idempotency guard — don't double-credit if cron runs twice quickly
  const { data: fresh } = await supabase
    .from('transactions')
    .select('status')
    .eq('id', txn.id)
    .single();

  if (fresh?.status === 'completed') {
    console.log(`[POLL] txn=${txn.id} already completed — skipping credit`);
    return 'already_completed';
  }

  // Mark transaction completed
  await supabase
    .from('transactions')
    .update({ status: 'completed', updated_at: new Date().toISOString(), raw_response: ycData })
    .eq('id', txn.id);

  // Credit wallet with optimistic upsert
  const { data: wallet } = await supabase
    .from('wallets')
    .select('balance')
    .eq('phone', txn.phone)
    .eq('currency', txn.currency)
    .single();

  const prev = parseFloat(wallet?.balance ?? 0);
  const next = prev + parseFloat(txn.amount);

  await supabase
    .from('wallets')
    .upsert({ phone: txn.phone, currency: txn.currency, balance: next, updated_at: new Date().toISOString() });

  console.log(`[POLL] ✅ Credited ${txn.amount} ${txn.currency} to ${txn.phone} — new balance: ${next}`);

  await sendWhatsApp(
    txn.phone,
    `✅ Top-up confirmed! *${txn.amount} ${txn.currency}* has been added to your wallet.\n\nNew balance: *${next} ${txn.currency}*\n\nReply *menu* to continue.`,
  );

  return `credited: ${prev} → ${next} ${txn.currency}`;
}
