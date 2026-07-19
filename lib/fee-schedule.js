const { publicAppUrl } = require('./app-url');
function buildFeeScheduleUrl() {
  return publicAppUrl('/api/fee-schedule');
}

/**
 * In-app notification body when KYC/KYB is approved (PayLink PWA inbox).
 */
function formatKycApprovalNotificationBody({ walletCurrency } = {}) {
  const walletLine = walletCurrency ? ` with a ${walletCurrency} wallet` : '';
  return (
    `Great news — you're verified! Welcome to PayLink. Your account is now active${walletLine}.\n\n` +
    `Tap this notification to open the PayLink fee schedule PDF.\n\n` +
    `Before every top-up or send, PayLink shows your exact fee in the app. Open the menu to get started.`
  );
}

/** @deprecated use formatKycApprovalNotificationBody — kept for tests importing old name */
function formatKycApprovalMessage(opts) {
  return formatKycApprovalNotificationBody(opts);
}

module.exports = {
  buildFeeScheduleUrl,
  formatKycApprovalNotificationBody,
  formatKycApprovalMessage,
};
