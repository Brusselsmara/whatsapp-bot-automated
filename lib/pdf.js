const PDFDocument = require('pdfkit');

/**
 * Builds a remittance/payment confirmation PDF as a Buffer, for a completed
 * transaction. Used by api/receipt.js to serve it, and referenced as a
 * WhatsApp media attachment once a send/invoice_payment completes.
 */
function buildRemittancePdf(txn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Payment Remittance', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).fillColor('#666').text(`Generated ${new Date().toISOString()}`, { align: 'center' });
    doc.moveDown(2);

    doc.fillColor('#000').fontSize(12);
    const row = (label, value) => {
      doc.font('Helvetica-Bold').text(label, { continued: true });
      doc.font('Helvetica').text('  ' + (value ?? '—'));
      doc.moveDown(0.3);
    };

    row('Transaction type:', txn.type === 'invoice_payment' ? 'Invoice payment' : 'Send money');
    row('Status:', txn.status.toUpperCase());
    row('Amount:', `${txn.amount} ${txn.currency}`);
    row('Reference:', txn.reference || txn.id);
    row('Recipient name:', txn.recipient_name);
    row('Recipient account:', txn.recipient_account_number);
    row('Payment channel:', txn.recipient_channel_type);
    row('Yellow Card reference:', txn.yellowcard_reference);
    row('Date:', new Date(txn.updated_at || txn.created_at).toLocaleString());

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999').text(
      'This is an automatically generated remittance confirmation from PayLink. Keep this for your records.',
      { align: 'center' }
    );

    doc.end();
  });
}

module.exports = { buildRemittancePdf };
