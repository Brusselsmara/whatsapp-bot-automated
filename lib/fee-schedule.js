const { publicAppUrl } = require('./app-url');
function buildFeeScheduleUrl() {
  return publicAppUrl('/api/fee-schedule');
}

/**
 * In-app notification body when KYC/KYB is approved (Romela Pula PWA inbox).
 */
function formatKycApprovalNotificationBody({ walletCurrency } = {}) {
  const walletLine = walletCurrency ? ` with a ${walletCurrency} wallet` : '';
  return (
    `Great news — you're verified! Welcome to Romela Pula. Your account is now active${walletLine}.\n\n` +
    `Tap this notification to open the Romela Pula fee schedule PDF.\n\n` +
    `Before every top-up or send, Romela Pula shows your exact fee in the app. Open the menu to get started.`
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
