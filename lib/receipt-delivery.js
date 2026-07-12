const { supabase } = require('./db');
const { sendWhatsApp } = require('./twilio');
const { publicAppUrl } = require('./app-url');
const { claimReceiptSent } = require('./settlement');

const SEND_COMPLETE = ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL', 'SETTLED'];

/**
 * Send the PDF receipt WhatsApp message for a completed send/invoice_payment.
 * Idempotent via claim_receipt_sent RPC.
 */
async function deliverSendReceipt(txn) {
  if (!txn?.id) return { sent: false, reason: 'no_id' };

  // Always reload — callers often pass a stale row (status still pending) right after claim_send_complete.
  const { data: row } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
  if (!row || row.receipt_sent || row.status !== 'completed') {
    return { sent: false, reason: 'not_eligible' };
  }

  const receiptClaim = await claimReceiptSent(row.id);
  if (!receiptClaim.claimed) {
    return { sent: false, reason: 'already_claimed' };
  }

  if (!publicAppUrl()) {
    console.error(`[RECEIPT] PUBLIC_APP_URL not set — cannot attach PDF for txn ${row.id}`);
    await supabase.from('transactions').update({ receipt_sent: false }).eq('id', row.id);
    return { sent: false, reason: 'missing_public_app_url' };
  }

  const receiptUrl = publicAppUrl(`/api/receipt?id=${row.id}`);
  console.log(`[RECEIPT] Attaching PDF for txn ${row.id}: ${receiptUrl}`);
  const label = row.type === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
  const displayAmount = row.payout_amount != null ? row.payout_amount : row.amount;
  const displayCurrency = row.payout_currency || row.currency;

  try {
    await sendWhatsApp(
      row.phone,
      `✅ *${label} confirmed!*\n\n*${displayAmount} ${displayCurrency}* sent to *${row.recipient_name}*.\n\nYour receipt is attached.`,
      receiptUrl
    );
    console.log(`[RECEIPT] ✅ Delivered for txn ${row.id}`);
    return { sent: true };
  } catch (e) {
    console.error(`[RECEIPT] WhatsApp send failed for ${row.id}:`, e.message);
    await supabase.from('transactions').update({ receipt_sent: false }).eq('id', row.id);
    return { sent: false, reason: e.message };
  }
}

module.exports = { deliverSendReceipt, SEND_COMPLETE };
