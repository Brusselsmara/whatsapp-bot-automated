const { supabase } = require('../lib/db');
const { buildRemittancePdf } = require('../lib/pdf');

// /api/receipt?id=<transaction_uuid>
// The UUID is hard to guess (128-bit random) which provides baseline protection.
// For stricter security a signed token would be added here.

module.exports = async (req, res) => {
  const { id } = req.query;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).send('Invalid id');
  }

  const { data: txn } = await supabase
    .from('transactions').select('*').eq('id', id).single();
  if (!txn) return res.status(404).send('Not found');

  // Only completed transactions get a receipt
  if (txn.status !== 'completed') return res.status(404).send('Not found');

  try {
    const pdfBuffer = await buildRemittancePdf(txn);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${id}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('Error building receipt PDF:', err);
    return res.status(500).send('Error generating receipt');
  }
};