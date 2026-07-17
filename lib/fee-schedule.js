const { publicAppUrl } = require('./app-url');
const { MOMO_LABEL } = require('./labels');

function buildFeeScheduleUrl() {
  return publicAppUrl('/api/fee-schedule');
}

/**
 * WhatsApp message sent when KYC/KYB is approved, with fee schedule PDF attached.
 */
function formatKycApprovalMessage({ walletCurrency } = {}) {
  const walletLine = walletCurrency ? ` with a *${walletCurrency}* wallet` : '';
  return (
    `✅ *Great news — you're verified!*\n\n` +
    `Welcome to *PayLink*! Your account is now active${walletLine}.\n\n` +
    `📎 *PayLink Fee Schedule* is attached — our top-up and send fees for *${MOMO_LABEL}* and *bank* transfers.\n\n` +
    `*Before every top-up or send*, PayLink shows your *exact fee* in WhatsApp. The PDF is a guide; your live quote is always what you confirm.\n\n` +
    `Reply *menu* to get started.`
  );
}

module.exports = { buildFeeScheduleUrl, formatKycApprovalMessage };
