const { supabase } = require('./db');
const { notifyUser } = require('./notifications');
const { buildReceiptUrl } = require('./receipt-signing');
const { claimReceiptSent } = require('./settlement');

const SEND_COMPLETE = ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL', 'SETTLED'];

/**
 * Deliver PDF receipt via PayLink PWA notification (in-app inbox).
 * Idempotent via claim_receipt_sent RPC.
 */
async function deliverSendReceipt(txn) {
  if (!txn?.id) return { sent: false, reason: 'no_id' };

  const { data: row } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
  if (!row || row.receipt_sent || row.status !== 'completed') {
    return { sent: false, reason: 'not_eligible' };
  }

  const receiptClaim = await claimReceiptSent(row.id);
  if (!receiptClaim.claimed) {
    return { sent: false, reason: 'already_claimed' };
  }

  // Relative /api/receipt URLs work in the PWA (same origin); absolute when PUBLIC_APP_URL is set.
  const receiptUrl = buildReceiptUrl(row.id);
  if (!receiptUrl) {
    console.error(`[RECEIPT] Could not build receipt URL for txn ${row.id}`);
    await supabase.from('transactions').update({ receipt_sent: false }).eq('id', row.id);
    return { sent: false, reason: 'missing_receipt_url' };
  }
  const label = row.type === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
  const displayAmount = row.payout_amount != null ? row.payout_amount : row.amount;
  const displayCurrency = row.payout_currency || row.currency;

  try {
    await notifyUser(row.phone, {
      type: 'receipt',
      title: `${label} confirmed`,
      body:
        `${displayAmount} ${displayCurrency} sent to ${row.recipient_name || 'recipient'}. ` +
        `Tap to download your PDF receipt.`,
      actionUrl: receiptUrl,
    });
    console.log(`[RECEIPT] ✅ PWA notification for txn ${row.id}`);
    return { sent: true };
  } catch (e) {
    console.error(`[RECEIPT] Notification failed for ${row.id}:`, e.message);
    await supabase.from('transactions').update({ receipt_sent: false }).eq('id', row.id);
    return { sent: false, reason: e.message };
  }
}

module.exports = { deliverSendReceipt, SEND_COMPLETE };
