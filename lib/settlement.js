/**
 * Atomic settlement via Postgres RPC (SELECT … FOR UPDATE).
 * Prevents double-credit / double-refund when webhook and cron fire together.
 */
const { supabase } = require('./db');

async function claimTopupCredit(txnId, ycResponse) {
  const { data, error } = await supabase.rpc('claim_topup_credit', {
    p_txn_id: txnId,
    p_yc_response: ycResponse ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    claimed: !!row?.claimed,
    phone: row?.phone,
    currency: row?.currency,
    amount: row?.amount != null ? parseFloat(row.amount) : null,
    newBalance: row?.new_balance != null ? parseFloat(row.new_balance) : null,
  };
}

async function claimSendComplete(txnId, ycResponse) {
  const { data, error } = await supabase.rpc('claim_send_complete', {
    p_txn_id: txnId,
    p_yc_response: ycResponse ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    claimed: !!row?.claimed,
    receiptPending: !!row?.receipt_pending,
    phone: row?.phone,
    invoiceId: row?.invoice_id,
  };
}

async function claimSendRefund(txnId, ycResponse) {
  const { data, error } = await supabase.rpc('claim_send_refund', {
    p_txn_id: txnId,
    p_yc_response: ycResponse ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    claimed: !!row?.claimed,
    phone: row?.phone,
    currency: row?.currency,
    amount: row?.amount != null ? parseFloat(row.amount) : null,
    newBalance: row?.new_balance != null ? parseFloat(row.new_balance) : null,
  };
}

async function claimReceiptSent(txnId) {
  const { data, error } = await supabase.rpc('claim_receipt_sent', {
    p_txn_id: txnId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { claimed: !!row?.claimed };
}

async function markTopupFailed(txnId, ycResponse) {
  const { data, error } = await supabase.rpc('mark_topup_failed', {
    p_txn_id: txnId,
    p_yc_response: ycResponse ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { claimed: !!row?.claimed, phone: row?.phone, amount: row?.amount, currency: row?.currency };
}

module.exports = {
  claimTopupCredit,
  claimSendComplete,
  claimSendRefund,
  claimReceiptSent,
  markTopupFailed,
};
