const { supabase } = require('./db');
const { normalizePhone } = require('./notifications');

const P2P_MAX_AMOUNT = parseFloat(
  process.env.ROMELA_PULA_P2P_MAX_AMOUNT || process.env.PAYLINK_P2P_MAX_AMOUNT || '5000'
);

const REASON_MESSAGES = {
  invalid_amount: 'Enter a valid amount greater than zero.',
  self_transfer: 'You cannot send money to yourself.',
  sender_not_eligible: 'Your account must be approved before sending to Romela Pula users.',
  recipient_not_eligible: 'That person is not on Romela Pula yet, or their account is not approved.',
  currency_mismatch: 'Romela Pula user-to-user transfers must be in the recipient\'s home currency for now.',
  insufficient_funds: 'Insufficient balance for this transfer.',
};

async function findRomelaPulaRecipient(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data: user } = await supabase
    .from('users')
    .select('phone, kyc_status, kyc_name, business_name, home_currency')
    .eq('phone', normalized)
    .maybeSingle();

  if (!user || user.kyc_status !== 'approved') return null;
  return user;
}

async function executeP2PTransfer({ senderPhone, recipientPhone, amount, currency, memo }) {
  const { data, error } = await supabase.rpc('transfer_wallet_p2p', {
    p_sender_phone: senderPhone,
    p_recipient_phone: recipientPhone,
    p_currency: currency,
    p_amount: amount,
    p_memo: memo || null,
  });

  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.claimed) {
    const reason = row?.reason || 'unknown';
    const message = REASON_MESSAGES[reason] || 'Transfer could not be completed. Reply *menu* to try again.';
    return { ok: false, reason, message };
  }

  return {
    ok: true,
    txnId: row.txn_id,
    senderBalance: parseFloat(row.sender_balance),
    recipientBalance: parseFloat(row.recipient_balance),
  };
}

module.exports = {
  P2P_MAX_AMOUNT,
  findRomelaPulaRecipient,
  executeP2PTransfer,
  REASON_MESSAGES,
};
