function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildTransactionsCsv(rows) {
  const headers = [
    'Date',
    'Type',
    'User',
    'Phone',
    'Channel',
    'Amount',
    'Currency',
    'Payout Amount',
    'Payout Currency',
    'Romela Pula Profit',
    'Markup',
    'FX Margin',
    'YC Fee',
    'Reference',
  ];

  const lines = [headers.map(csvEscape).join(',')];

  for (const r of rows) {
    lines.push([
      new Date(r.createdAt).toISOString(),
      r.typeLabel,
      r.userName,
      r.phone,
      r.channel,
      r.amount.toFixed(2),
      r.currency,
      r.payoutAmount != null ? r.payoutAmount.toFixed(2) : '',
      r.payoutAmount != null ? r.payoutCurrency : '',
      r.profit.romelaPulaProfit.toFixed(2),
      r.profit.markup.toFixed(2),
      r.profit.fxMargin.toFixed(2),
      r.profit.ycFee.toFixed(2),
      r.reference || '',
    ].map(csvEscape).join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

function csvFilename(filters) {
  const from = filters?.fromLabel || 'all';
  const to = filters?.toLabel || 'all';
  return `romela-pula-transactions-${from}-to-${to}.csv`;
}

module.exports = { buildTransactionsCsv, csvFilename, csvEscape };
