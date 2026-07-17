/** User-facing label for the mobile money channel. */
const MOMO_LABEL = 'Momo (Mobile Money)';

function channelLabel(channelType) {
  return channelType === 'bank' ? 'Bank transfer' : MOMO_LABEL;
}

function channelLabelInline(channelType) {
  return channelType === 'bank' ? 'bank transfer' : MOMO_LABEL;
}

module.exports = { MOMO_LABEL, channelLabel, channelLabelInline };
