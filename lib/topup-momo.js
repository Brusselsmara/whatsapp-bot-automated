const yc = require('./yellowcard');
const { MOMO_LABEL } = require('./labels');

function countryDisplayName(country) {
  return yc.COUNTRY_CONFIG[country]?.name || country;
}

/** Prompt for the momo payer number — separate from the WhatsApp account number. */
function topupMomoNumberPrompt({ country, currency, whatsappPhone }) {
  const name = countryDisplayName(country);
  const dialCode = yc.COUNTRY_CONFIG[country]?.dialCode;
  const example = dialCode ? `+${dialCode}…` : `a ${name} number`;
  const sandboxByCountry = {
    BW: 'Sandbox success: *+2671111111111* · fail: *+2670000000000*',
    ZM: 'Sandbox success: *+2601111111111* · fail: *+2600000000000*',
  };
  const sandboxLine = sandboxByCountry[country]
    ? `\n\n_${sandboxByCountry[country]}_`
    : '';

  const wa = whatsappPhone ? yc.toInternationalPhone(whatsappPhone, country) : null;
  const shortcutLine = wa
    ? `\n\nReply *1* to pay from your WhatsApp number (*${wa}*), or enter a different ${MOMO_LABEL} number.`
    : '';

  return (
    `Enter the *${name}* ${MOMO_LABEL} number you will pay from (your *${currency}* wallet).\n\n` +
    `Use international format (e.g. *${example}*).\n\n` +
    `⚠️ The USSD prompt is sent to the number you enter — *not necessarily this WhatsApp chat*. ` +
    `Keep that phone nearby to approve the payment.${shortcutLine}${sandboxLine}`
  );
}

function isUseWhatsappShortcut(msg) {
  return String(msg || '').trim() === '1';
}

function formatWhatsappMomoConfirm(momoNumber) {
  return (
    `The USSD prompt will be sent to *${momoNumber}* (your WhatsApp number).\n\n` +
    `Reply *yes* to confirm, or *no* to enter a different ${MOMO_LABEL} number.`
  );
}

function isAffirmative(msg) {
  const m = String(msg || '').trim().toLowerCase();
  return ['yes', 'y', 'confirm', 'ok'].includes(m);
}

function isNegative(msg) {
  const m = String(msg || '').trim().toLowerCase();
  return ['no', 'n', 'cancel'].includes(m);
}

function formatNetworkLabel(network) {
  return network?.name || network?.id || 'Provider';
}

function formatNetworkPickerPrompt(networks) {
  const lines = networks.map((n, i) => `${i + 1}️⃣ ${formatNetworkLabel(n)}`);
  return `Which ${MOMO_LABEL} provider is your number registered with?\n\n${lines.join('\n')}`;
}

function parseNetworkChoice(msg, networks) {
  const choice = parseInt(String(msg || '').trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > networks.length) return null;
  return networks[choice - 1];
}

function formatReceiveExpiryMins(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60000));
}

function formatMomoTopupSuccessMessage({
  amount,
  currency,
  topupFee,
  netCredit,
  reference,
  momoNumber,
  expiresAt,
  sandbox,
}) {
  const expiresMins = formatReceiveExpiryMins(expiresAt);
  const expiryLine = expiresMins ? `\n⏳ Approve the USSD within ~${expiresMins} minutes.` : '';
  const sandboxNote = sandbox
    ? `\n\n_🧪 Sandbox: USSD may be simulated — use test numbers if you don't receive a prompt._`
    : '';

  return (
    `✅ Top-up of ${amount} ${currency} initiated via ${MOMO_LABEL}.\n\n` +
    `📱 A USSD prompt will be sent to *${momoNumber}* — approve it on that phone to complete payment ` +
    `(this may differ from your WhatsApp number).${expiryLine}\n\n` +
    `A top-up fee of *${parseFloat(topupFee || 0).toFixed(2)} ${currency}* will be deducted on success ` +
    `(*${parseFloat(netCredit || amount).toFixed(2)} ${currency}* will be added to your wallet).\n\n` +
    `Reference: ${reference}\n\n` +
    `Your balance will update automatically once confirmed.${sandboxNote}`
  );
}

module.exports = {
  topupMomoNumberPrompt,
  isUseWhatsappShortcut,
  formatWhatsappMomoConfirm,
  isAffirmative,
  isNegative,
  formatNetworkPickerPrompt,
  parseNetworkChoice,
  formatReceiveExpiryMins,
  formatMomoTopupSuccessMessage,
};
