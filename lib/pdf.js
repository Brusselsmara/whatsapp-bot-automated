const PDFDocument = require('pdfkit');
const { computeInvoiceCustomerFeesFromTxn } = require('./quotes');
const { TOPUP_FLAT_FEE_BWP, ROMELA_PULA_SEND_FEE_TIERS } = require('./fees');
const yc = require('./yellowcard');
const { MOMO_LABEL } = require('./labels');

function pdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function channelSummary(types = []) {
  const hasBank = types.includes('bank');
  const hasMomo = types.includes('momo');
  if (hasBank && hasMomo) return `${MOMO_LABEL} & bank`;
  if (hasBank) return 'Bank only';
  if (hasMomo) return `${MOMO_LABEL} only`;
  return '—';
}

/**
 * Customer-facing fee schedule PDF (Romela Pula fees only — no third-party rail breakdown).
 * @param {object} [opts]
 * @param {string} [opts.walletCurrency] - highlight user's home wallet currency when known
 */
async function buildFeeSchedulePdf({ walletCurrency } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const done = pdfBuffer(doc);

  const heading = (text, size = 14) => {
    doc.moveDown(0.5);
    doc.fontSize(size).fillColor('#000').font('Helvetica-Bold').text(text);
    doc.moveDown(0.3);
  };

  const body = (text) => {
    doc.fontSize(10).fillColor('#333').font('Helvetica').text(text, { lineGap: 3 });
    doc.moveDown(0.4);
  };

  const bullet = (text) => {
    doc.fontSize(10).fillColor('#333').font('Helvetica').text(`•  ${text}`, { lineGap: 2 });
  };

  doc.fontSize(20).fillColor('#000').font('Helvetica-Bold').text('Romela Pula Fee Schedule', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#666').font('Helvetica').text(`Top-up & send fees — ${MOMO_LABEL} and bank`, { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).text(`Generated ${new Date().toISOString()}`, { align: 'center' });
  if (walletCurrency) {
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#000').text(`Your wallet currency: ${walletCurrency}`, { align: 'center' });
  }
  doc.moveDown(1);

  heading('1. How Romela Pula charges you', 13);
  body(
    'Romela Pula shows one total fee before you confirm each top-up or send. This document explains Romela Pula\'s fee structure only. ' +
    'The exact amount always appears in WhatsApp when you top up or send — use that quote when you reply confirm.'
  );

  heading('2. Top-up fees (fund your wallet)', 13);
  body(`Romela Pula processing fee: BWP ${TOPUP_FLAT_FEE_BWP} flat per top-up (converted to your wallet currency at the time of top-up).`);
  bullet(`Applies to ${MOMO_LABEL} and bank top-ups where available.`);
  bullet('An additional variable processing component may apply based on amount and channel.');
  bullet('The total fee is deducted when your top-up completes successfully.');
  bullet('Wallet credit = top-up amount minus total fee.');
  doc.moveDown(0.5);

  body('Top-up channels by country (registerable corridors):');
  doc.moveDown(0.2);
  const registerable = yc.getRegisterableCorridors();
  for (const row of registerable) {
    bullet(`${row.name} (${row.currency}): ${channelSummary(row.channelTypes)}`);
  }

  heading('3. Send fees (pay out to someone)', 13);
  body(
    'Romela Pula charges a tiered service fee based on transfer size (converted to BWP equivalent for tiering), ' +
    `plus a variable processing component that depends on amount, destination country, and channel (${MOMO_LABEL} or bank).`
  );
  doc.moveDown(0.3);
  body('Romela Pula tiered service fee (BWP equivalent of transfer size):');
  doc.moveDown(0.2);
  for (const tier of ROMELA_PULA_SEND_FEE_TIERS) {
    bullet(`${tier.label}: BWP ${tier.feeBwp}`);
  }
  doc.moveDown(0.5);

  body('Domestic send (same currency, e.g. BWP to BWP):');
  bullet('Recipient receives the amount you enter.');
  bullet('Total debit = send amount + total Romela Pula fee (shown as one line before you confirm).');
  doc.moveDown(0.3);

  body('Cross-border send (e.g. BWP to ZMW):');
  bullet('You enter the total from your wallet (fees included).');
  bullet('Romela Pula works out recipient amount, exchange rate, and fees internally.');
  bullet('Your quote shows total you pay, approximate recipient amount, and rate.');
  doc.moveDown(0.3);

  body(`${MOMO_LABEL} vs bank:`);
  bullet('Both use the same Romela Pula tier table above.');
  bullet(`The variable processing part can differ between ${MOMO_LABEL} and bank — your WhatsApp quote shows the exact total for your chosen channel.`);

  heading('4. Invoice payments', 13);
  body(
    'Paying a supplier invoice uses the same Romela Pula send fee model. The supplier receives the invoice amount; ' +
    'your wallet is debited for the invoice plus fees (and FX margin when the invoice currency differs from your wallet).'
  );

  heading('5. What you see in WhatsApp', 13);
  bullet('Top-up: fee to be deducted + net amount added to wallet.');
  bullet('Domestic send: total fees + total debit.');
  bullet('Cross-border send: total you pay (fees included) + recipient amount + rate.');
  bullet('Invoice payment: total charge in your wallet currency.');
  doc.moveDown(1);

  doc.fontSize(9).fillColor('#999').text(
    'Romela Pula — This schedule may be updated. The fee shown in WhatsApp at confirmation time applies. Reply menu for support.',
    { align: 'center' }
  );

  doc.end();
  return done;
}


function getSenderReceiptRow(user) {
  if (!user) return null;
  if (user.account_type === 'business') {
    const name = user.business_name || user.kyc_name;
    return name ? { label: "Sender's Business name:", value: name } : null;
  }
  const name = user.kyc_name || user.business_name;
  return name ? { label: 'Sender name:', value: name } : null;
}

/**
 * Builds a remittance/payment confirmation PDF as a Buffer, for a completed
 * transaction. Used by api/receipt.js to serve it, and referenced as a
 * WhatsApp media attachment once a send/invoice_payment completes.
 * @param {object} txn - transaction row
 * @param {object} [user] - users row (account_type, kyc_name, business_name)
 */
function buildRemittancePdf(txn, user) {
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

    const payoutCurrency = txn.payout_currency || txn.currency;
    row('Transaction type:', txn.type === 'invoice_payment' ? 'Invoice payment' : 'Send money');
    row('Status:', txn.status.toUpperCase());
    const senderRow = getSenderReceiptRow(user);
    if (senderRow) row(senderRow.label, senderRow.value);
    const isCrossBorder = txn.payout_amount != null && payoutCurrency !== txn.currency;
    const customerFee = txn.type === 'invoice_payment'
      ? computeInvoiceCustomerFeesFromTxn(txn)
      : (parseFloat(txn.yc_fee_amount) || 0) + (parseFloat(txn.markup_amount) || 0);
    const feeCurrency = isCrossBorder ? txn.currency : (txn.payout_currency || txn.currency);
    if (txn.payout_amount != null) {
      row('Amount received by recipient:', `${txn.payout_amount} ${payoutCurrency}`);
      if (isCrossBorder && txn.display_rate) {
        row('Exchange rate:', `1 ${txn.currency} = ${parseFloat(txn.display_rate).toFixed(4)} ${payoutCurrency}`);
      }
      if (isCrossBorder) {
        row('Total debited from wallet:', `${txn.amount} ${txn.currency} (fees included)`);
      } else {
        row('Fees:', `${customerFee.toFixed(2)} ${feeCurrency}`);
        row('Total debited from wallet:', `${txn.amount} ${txn.currency}`);
      }
    } else {
      row('Amount:', `${txn.amount} ${txn.currency}`);
    }
    row('Reference:', txn.reference || txn.id);
    row('Recipient name:', txn.recipient_name);
    row('Recipient account:', txn.recipient_account_number);
    row('Payment channel:', txn.recipient_channel_type);
    row('Transaction reference:', txn.yellowcard_reference);
    row('Date:', new Date(txn.updated_at || txn.created_at).toLocaleString());

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999').text(
      'This is an automatically generated remittance confirmation from Romela Pula. Keep this for your records.',
      { align: 'center' }
    );

    doc.end();
  });
}

module.exports = { buildRemittancePdf, buildFeeSchedulePdf };
