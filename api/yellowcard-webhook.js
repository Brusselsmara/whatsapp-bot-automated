const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const { verifyWebhookSignature } = require('../lib/yellowcard');

// Paste this URL into Yellow Card's webhook registration (see scripts/register-webhook.js):
//   https://<your-vercel-app>.vercel.app/api/yellowcard-webhook

module.exports.config = {
  api: { bodyParser: false }, // need the raw body to verify X-YC-Signature
};

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
    console.error('Yellow Card webhook signature mismatch — rejecting.');
    return res.status(403).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send('Invalid JSON');
  }

  try {
    const status = mapStatus(event.event);
    const ycId = event.id;
    if (!ycId || !status) {
      return res.status(200).json({ received: true, note: 'Unrecognized event, ignored' });
    }

    const { data: txn } = await supabase
      .from('transactions')
      .update({ status, updated_at: new Date().toISOString(), raw_response: event })
      .eq('yellowcard_reference', ycId)
      .select()
      .single();

    if (!txn) return res.status(200).json({ received: true, note: 'No matching transaction' });

    if (txn.type === 'topup') {
      await handleTopupUpdate(txn, status);
    } else {
      // 'send' or 'invoice_payment'
      await handleSendUpdate(txn, status, event);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Error processing Yellow Card webhook:', err);
    return res.status(200).json({ received: true, error: 'internal error logged' });
  }
};

async function handleTopupUpdate(txn, status) {
  if (status === 'completed') {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('phone', txn.phone)
      .eq('currency', txn.currency)
      .single();

    const newBalance = (wallet ? parseFloat(wallet.balance) : 0) + parseFloat(txn.amount);
    await supabase
      .from('wallets')
      .upsert({ phone: txn.phone, currency: txn.currency, balance: newBalance, updated_at: new Date().toISOString() });

    await sendWhatsApp(
      txn.phone,
      `💰 Your top-up of ${txn.amount} ${txn.currency} is confirmed. New balance: ${newBalance} ${txn.currency}.`
    );
  } else if (status === 'failed') {
    await sendWhatsApp(txn.phone, `⚠️ Your top-up of ${txn.amount} ${txn.currency} failed. Please reply "menu" to try again.`);
  }
}

async function handleSendUpdate(txn, status, event) {
  if (status === 'completed') {
    const receiptUrl = `${process.env.PUBLIC_APP_URL}/api/receipt?id=${txn.id}`;
    const label = txn.type === 'invoice_payment' ? 'Invoice payment' : 'Transfer';

    await sendWhatsApp(
      txn.phone,
      `✅ ${label} of ${txn.amount} ${txn.currency} to ${txn.recipient_name} is confirmed. Your remittance receipt is attached.`,
      receiptUrl
    );
    await supabase.from('transactions').update({ receipt_sent: true }).eq('id', txn.id);
  } else if (status === 'failed') {
    // Refund the wallet since we debited it up front when the send was submitted.
    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('phone', txn.phone)
      .eq('currency', txn.currency)
      .single();

    const refunded = (wallet ? parseFloat(wallet.balance) : 0) + parseFloat(txn.amount);
    await supabase
      .from('wallets')
      .upsert({ phone: txn.phone, currency: txn.currency, balance: refunded, updated_at: new Date().toISOString() });

    await sendWhatsApp(
      txn.phone,
      `⚠️ Your payment of ${txn.amount} ${txn.currency} to ${txn.recipient_name} failed${event.errorCode ? ` (${event.errorCode})` : ''}. Your balance has been refunded.`
    );
  }
}

function mapStatus(eventName) {
  if (!eventName) return null;
  if (eventName.endsWith('.COMPLETE') || eventName.endsWith('.COMPLETED')) return 'completed';
  if (eventName.endsWith('.PROCESSING')) return 'processing';
  if (eventName.endsWith('.FAILED') || eventName.endsWith('.EXPIRED')) return 'failed';
  if (eventName.endsWith('.PENDING')) return 'pending';
  return null;
}
