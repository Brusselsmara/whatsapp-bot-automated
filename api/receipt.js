const { supabase } = require('../lib/db');
const { buildRemittancePdf } = require('../lib/pdf');

// URL shape: /api/receipt?id=<transaction_id>
// This is what gets passed as Twilio's mediaUrl when sending a remittance
// receipt, so Twilio's servers fetch this URL directly. The transaction id
// is a UUID (hard to guess), which is an acceptable level of protection for
// a receipt document — nothing else in the app relies on this being secret.

module.exports = async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const { data: txn } = await supabase.from('transactions').select('*').eq('id', id).single();
  if (!txn) return res.status(404).send('Not found');

  try {
    const pdfBuffer = await buildRemittancePdf(txn);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${id}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('Error building receipt PDF:', err);
    return res.status(500).send('Error generating receipt');
  }
};
