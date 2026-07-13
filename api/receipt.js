const { supabase } = require('../lib/db');
const { buildRemittancePdf } = require('../lib/pdf');
const { isReceiptSigningEnforced, verifyReceiptSignature } = require('../lib/receipt-signing');

// /api/receipt?id=<transaction_uuid>[&sig=<hmac>]
// When RECEIPT_SIGNING_SECRET (or CRON_SECRET) is set in production, sig is required.

module.exports = async (req, res) => {
  const { id, sig } = req.query;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).send('Invalid id');
  }

  if (isReceiptSigningEnforced() && !verifyReceiptSignature(id, sig)) {
    return res.status(403).send('Forbidden');
  }
  const { data: txn } = await supabase
    .from('transactions').select('*').eq('id', id).single();
  if (!txn) return res.status(404).send('Not found');

  // Only completed transactions get a receipt
  if (txn.status !== 'completed') return res.status(404).send('Not found');

  const { data: user } = await supabase
    .from('users')
    .select('account_type, kyc_name, business_name')
    .eq('phone', txn.phone)
    .maybeSingle();

  try {
    const pdfBuffer = await buildRemittancePdf(txn, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${id}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('Error building receipt PDF:', err);
    return res.status(500).send('Error generating receipt');
  }
};