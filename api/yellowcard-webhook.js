const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const { getWebhookSignature, verifyWebhookSignature } = require('../lib/yellowcard');
const {
  claimTopupCredit,
  claimSendComplete,
  claimSendRefund,
  markTopupFailed,
} = require('../lib/settlement');
const { deliverSendReceipt } = require('../lib/receipt-delivery');
const { formatTopupSettlementMessage } = require('../lib/quotes');
const { captureError } = require('../lib/observability');

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
  const signature = getWebhookSignature(req.headers);

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error('[WEBHOOK] Signature mismatch — rejecting (401)');
    return res.status(401).send('Unauthorized');
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

    let txn = await findTxn(ycId);
    if (!txn) txn = await findTxn(event.sequenceId || '');

    if (!txn) {
      console.warn(`[WEBHOOK] No transaction found for ycId=${ycId}`);
      return res.status(200).json({ received: true, note: 'no matching transaction' });
    }

    if (txn.type === 'topup') await handleTopupUpdate(txn, status, event);
    else await handleSendUpdate(txn, status, event);

    return res.status(200).json({ received: true });
  } catch (err) {
    captureError(err, { handler: 'yellowcard-webhook', event: event?.event, ycId: event?.id });
    return res.status(500).json({ received: false, error: 'logged' });
  }
};

async function findTxn(ycId) {
  if (!ycId) return null;
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('yellowcard_reference', ycId)
    .maybeSingle();
  return data || null;
}

async function handleTopupUpdate(txn, status, event) {
  if (status === 'completed') {
    try {
      const result = await claimTopupCredit(txn.id, event);
      if (!result.claimed) {
        console.warn(`[WEBHOOK] topup ${txn.id} RECEIVE.COMPLETE but claimed=false — check wallet_credited / run db/schema.sql`);
        return;
      }
      console.log(`[WEBHOOK] ✅ Topup credited ${result.netAmount} ${result.currency} (gross ${result.amount}, fee ${result.feeAmount}) — balance ${result.newBalance}`);
      await sendWhatsApp(result.phone,
        formatTopupSettlementMessage({
          grossAmount: result.amount,
          netAmount: result.netAmount,
          feeAmount: result.feeAmount,
          currency: result.currency,
          newBalance: result.newBalance,
        }));
    } catch (err) {
      captureError(err, { handler: 'yellowcard-webhook', action: 'claim_topup_credit', txnId: txn.id });
      throw err;
    }

  } else if (status === 'failed') {
    const result = await markTopupFailed(txn.id, event);
    if (!result.claimed) return;
    await sendWhatsApp(result.phone,
      `⚠️ Your top-up of *${result.amount} ${result.currency}* failed. Please reply *menu* to try again.`);
  } else {
    await supabase.from('transactions')
      .update({ status, updated_at: new Date().toISOString(), raw_response: event })
      .eq('id', txn.id)
      .in('status', ['pending', 'processing', 'created']);
  }
}

async function handleSendUpdate(txn, status, event) {
  if (status === 'completed') {
    const result = await claimSendComplete(txn.id, event);
    if (!result.claimed) {
      const { data: fresh } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
      if (fresh?.status === 'completed' && !fresh.receipt_sent) {
        await deliverSendReceipt(fresh);
      }
      console.log(`[WEBHOOK] send ${txn.id} already completed — skipping`);
      return;
    }

    if (result.invoiceId) {
      await supabase.from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', result.invoiceId);
    }

    if (result.receiptPending) {
      const { data: fresh } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
      await deliverSendReceipt(fresh || txn);
    }

  } else if (status === 'failed') {
    const result = await claimSendRefund(txn.id, event);
    if (!result.claimed) {
      console.log(`[WEBHOOK] send ${txn.id} refund already processed — skipping`);
      return;
    }
    console.log(`[WEBHOOK] ↩️ Refunded ${result.amount} ${result.currency} — balance ${result.newBalance}`);
    const { data: fresh } = await supabase.from('transactions').select('recipient_name').eq('id', txn.id).single();
    await sendWhatsApp(result.phone,
      `⚠️ Your transfer of *${result.amount} ${result.currency}* to ${fresh?.recipient_name || txn.recipient_name} failed. Your balance has been refunded.`);

  } else {
    await supabase.from('transactions')
      .update({ status, updated_at: new Date().toISOString(), raw_response: event })
      .eq('id', txn.id)
      .in('status', ['pending', 'processing', 'created']);
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
