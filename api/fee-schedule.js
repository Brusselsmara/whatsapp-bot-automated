const { buildFeeSchedulePdf } = require('../lib/pdf');

// GET /api/fee-schedule — public Romela Pula fee schedule PDF (no PII).
module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed');
  }

  const walletCurrency = typeof req.query.currency === 'string'
    ? req.query.currency.trim().toUpperCase()
    : undefined;

  try {
    const pdfBuffer = await buildFeeSchedulePdf({ walletCurrency });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Romela-Pula-Fee-Schedule.pdf"');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.method === 'HEAD') {
      return res.status(200).end();
    }
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('[FEE-SCHEDULE] PDF generation failed:', err);
    return res.status(500).send('Error generating fee schedule');
  }
};
