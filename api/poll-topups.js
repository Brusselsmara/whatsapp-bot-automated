const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const yc = require('../lib/yellowcard');
const {
  claimTopupCredit,
  claimSendComplete,
  claimSendRefund,
  markTopupFailed,
} = require('../lib/settlement');
const { deliverSendReceipt, SEND_COMPLETE } = require('../lib/receipt-delivery');

/**
 * GET /api/poll-topups
 * Polls Yellow Card for all unsettled topups and sends across ALL users.
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
    const { data: byStatus, error: statusErr } = await supabase
      .from('transactions')
      .select('*')
      .not('status', 'in', '("completed","failed")')
      .in('type', ['topup', 'send', 'invoice_payment'])
      .order('created_at', { ascending: true })
      .limit(50);

    const { data: uncreditedTopups, error: uncreditedErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('type', 'topup')
      .eq('wallet_credited', false)
      .neq('status', 'failed')
      .order('created_at', { ascending: true })
      .limit(50);

    const { data: pendingReceipts, error: receiptErr } = await supabase
      .from('transactions')
      .select('*')
      .in('type', ['send', 'invoice_payment'])
      .eq('status', 'completed')
      .eq('receipt_sent', false)
      .order('created_at', { ascending: true })
      .limit(50);

    const error = statusErr || uncreditedErr || receiptErr;
    const seen = new Set();
    const pending = [];
    for (const txn of [...(byStatus || []), ...(uncreditedTopups || []), ...(pendingReceipts || [])]) {
      if (!seen.has(txn.id)) {
        seen.add(txn.id);
        pending.push(txn);
      }
    }

    if (error) {
      console.error('[POLL] Query error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!pending || pending.length === 0) {
      return res.status(200).json({ polled: 0, message: 'Nothing pending' });
    }

    console.log(`[POLL] Checking ${pending.length} transaction(s)`);

    const results = await Promise.allSettled(pending.map((txn) => {
      if (txn.status === 'completed' && !txn.receipt_sent && txn.type !== 'topup') {
        return deliverSendReceipt(txn).then((r) => (r.sent ? 'receipt_sent' : `receipt_skipped:${r.reason}`));
      }
      return pollOne(txn);
    }));

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
    ycData = txn.type === 'topup' ? await yc.getReceive(ref) : await yc.getSend(ref);
  } catch (err) {
    console.error(`[POLL] Fetch failed for ${txn.id}:`, err.message);
    return `fetch_error: ${err.message}`;
  }

  const ycStatus = (ycData?.status || '').toUpperCase();
  console.log(`[POLL] txn=${txn.id} type=${txn.type} ycStatus=${ycStatus}`);

  const COMPLETE = SEND_COMPLETE;
  const FAILED = ['FAILED', 'EXPIRED', 'CANCELLED'];

  if (COMPLETE.includes(ycStatus)) {
    return txn.type === 'topup' ? creditWallet(txn, ycData) : completeSend(txn, ycData);
  }

  if (FAILED.includes(ycStatus)) {
    return txn.type === 'topup' ? failTopup(txn, ycData) : failSend(txn, ycData);
  }

  return `still_${ycStatus.toLowerCase() || 'pending'}`;
}

async function creditWallet(txn, ycData) {
  try {
    const result = await claimTopupCredit(txn.id, ycData);
    if (!result.claimed) {
      console.warn(`[POLL] topup ${txn.id} complete on YC but claimed=false — check wallet_credited / run db/schema.sql`);
      return 'already_completed';
    }

    console.log(`[POLL] ✅ Credited ${result.amount} ${result.currency} — balance ${result.newBalance}`);
    await sendWhatsApp(result.phone,
      `✅ Top-up confirmed!\n\n*${result.amount} ${result.currency}* added to your wallet.\nNew balance: *${result.newBalance} ${result.currency}*\n\nReply *menu* to continue.`);

    return `credited: ${result.newBalance}`;
  } catch (err) {
    console.error(`[POLL] claim_topup_credit failed for ${txn.id}:`, err.message);
    return `credit_error: ${err.message}`;
  }
}

async function failTopup(txn, ycData) {
  const result = await markTopupFailed(txn.id, ycData);
  if (!result.claimed) return 'already_failed';

  await sendWhatsApp(result.phone,
    `⚠️ Your top-up of *${result.amount} ${result.currency}* could not be completed. Please reply *menu* to try again.`);
  return 'failed';
}

async function completeSend(txn, ycData) {
  const result = await claimSendComplete(txn.id, ycData);
  if (!result.claimed) {
    const { data: fresh } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
    if (fresh?.status === 'completed' && !fresh.receipt_sent) {
      const r = await deliverSendReceipt(fresh);
      return r.sent ? 'receipt_sent' : `receipt_skipped:${r.reason}`;
    }
    return 'already_completed';
  }

  if (result.invoiceId) {
    await supabase.from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', result.invoiceId);
  }

  if (result.receiptPending) {
    const r = await deliverSendReceipt(txn);
    if (!r.sent) return `notify_failed: ${r.reason}`;
  }

  return 'send_completed';
}

async function failSend(txn, ycData) {
  const result = await claimSendRefund(txn.id, ycData);
  if (!result.claimed) return 'already_failed';

  console.log(`[POLL] ↩️ Refunded ${result.amount} ${result.currency} — balance ${result.newBalance}`);
  const { data: fresh } = await supabase.from('transactions').select('recipient_name').eq('id', txn.id).single();
  await sendWhatsApp(result.phone,
    `⚠️ Your transfer of *${result.amount} ${result.currency}* to ${fresh?.recipient_name || txn.recipient_name} failed. Your balance has been refunded.`);

  return 'send_failed_refunded';
}
