const { getPublicInvoice, normalizeInvoiceCode } = require('../lib/invoices');

/**
 * GET /api/invoice?code=INV-XXXX
 * Public invoice preview for payment links (no auth, no PII).
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = normalizeInvoiceCode(req.query.code);
  if (!code) {
    return res.status(400).json({ error: 'Invalid invoice code.' });
  }

  try {
    const invoice = await getPublicInvoice(code);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60');
    if (req.method === 'HEAD') {
      return res.status(200).end();
    }
    return res.status(200).json({ invoice });
  } catch (err) {
    console.error('[INVOICE API]', err.message);
    return res.status(500).json({ error: 'Could not load invoice.' });
  }
};
