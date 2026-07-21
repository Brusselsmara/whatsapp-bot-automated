const { addMoney, subMoney, divideByRate } = require('./money');
const { CROSSBORDER_FX_MARGIN_PCT } = require('./quotes');
const { isTxnInRange } = require('./admin-filters');

function emptyBucket() {
  return {
    gross: 0,
    bank: 0,
    momo: 0,
    count: 0,
  };
}

function emptyProfit() {
  return {
    markup: 0,
    fxMargin: 0,
    total: 0,
    ycFees: 0,
  };
}

function emptyBalance() {
  return {
    topupPoolAfterProfit: 0,
    netCreditedToWallets: 0,
    userWalletLiabilities: 0,
    impliedFloat: 0,
  };
}

function addToBucket(bucket, amount, channelType) {
  const n = parseFloat(amount) || 0;
  bucket.gross = addMoney(bucket.gross, n);
  bucket.count += 1;
  if (channelType === 'bank') bucket.bank = addMoney(bucket.bank, n);
  else if (channelType === 'momo') bucket.momo = addMoney(bucket.momo, n);
}

function addToProfit(bucket, profit) {
  bucket.markup = addMoney(bucket.markup, profit.markup);
  bucket.fxMargin = addMoney(bucket.fxMargin, profit.fxMargin);
  bucket.total = addMoney(bucket.total, profit.romelaPulaProfit);
  bucket.ycFees = addMoney(bucket.ycFees, profit.ycFee);
}

/** Romela Pula profit components for a completed transaction row. */
function computeTxnProfit(txn) {
  const markup = parseFloat(txn.markup_amount || 0) || 0;
  const ycFee = parseFloat(txn.yc_fee_amount || 0) || 0;

  if (txn.type === 'topup') {
    return { markup, fxMargin: 0, ycFee, romelaPulaProfit: markup };
  }

  if (txn.type === 'send' || txn.type === 'invoice_payment') {
    const payoutCurrency = txn.payout_currency || txn.currency;
    const isCross = payoutCurrency !== txn.currency && txn.display_rate && txn.payout_amount != null;

    if (!isCross) {
      return { markup, fxMargin: 0, ycFee, romelaPulaProfit: markup };
    }

    const face = parseFloat(txn.payout_amount);
    const walletDebit = parseFloat(txn.amount);
    const displayRate = parseFloat(txn.display_rate);
    const marginPct = parseFloat(txn.margin_pct ?? CROSSBORDER_FX_MARGIN_PCT);
    const bridgedRate = displayRate / (1 - marginPct);
    const principalWallet = divideByRate(face, bridgedRate);
    const totalCustomerFees = subMoney(walletDebit, principalWallet);
    const romelaPulaProfit = subMoney(totalCustomerFees, ycFee);
    const fxMargin = Math.max(0, subMoney(romelaPulaProfit, markup));

    return { markup, fxMargin, ycFee, romelaPulaProfit };
  }

  return { markup: 0, fxMargin: 0, ycFee: 0, romelaPulaProfit: 0 };
}

function ensureCurrency(map, currency) {
  if (!map[currency]) {
    map[currency] = {
      moneyIn: emptyBucket(),
      moneyOut: emptyBucket(),
      profit: emptyProfit(),
      balance: emptyBalance(),
    };
  }
  return map[currency];
}

function channelLabel(channelType) {
  if (channelType === 'bank') return 'Bank';
  if (channelType === 'momo') return 'Momo (Mobile Money)';
  return channelType || '—';
}

function typeLabel(type) {
  if (type === 'topup') return 'Top-up';
  if (type === 'send') return 'Send';
  if (type === 'invoice_payment') return 'Invoice';
  return type;
}

function formatMoney(amount, currency) {
  return `${parseFloat(amount || 0).toFixed(2)} ${currency}`;
}

function mapTransactionRow(t, userByPhone) {
  const profit = computeTxnProfit(t);
  const user = userByPhone[t.phone];
  return {
    id: t.id,
    createdAt: t.created_at,
    type: t.type,
    typeLabel: typeLabel(t.type),
    phone: t.phone,
    userName: user?.business_name || user?.kyc_name || user?.display_name || t.phone,
    amount: parseFloat(t.amount),
    currency: t.currency,
    payoutAmount: t.payout_amount != null ? parseFloat(t.payout_amount) : null,
    payoutCurrency: t.payout_currency || t.currency,
    channel: channelLabel(t.recipient_channel_type),
    profit,
    reference: t.yellowcard_reference || t.reference,
  };
}

function buildDashboardFromData({ users, transactions, wallets, filters = {} }) {
  const userByPhone = Object.fromEntries((users || []).map((u) => [u.phone, u]));
  const byCurrency = {};
  const completedInRange = (transactions || []).filter(
    (t) => t.status === 'completed' && userByPhone[t.phone] && isTxnInRange(t, filters)
  );

  for (const txn of completedInRange) {
    const currency = txn.currency;
    const bucket = ensureCurrency(byCurrency, currency);
    const profit = computeTxnProfit(txn);
    const channel = txn.recipient_channel_type;

    if (txn.type === 'topup') {
      addToBucket(bucket.moneyIn, txn.amount, channel);
      bucket.balance.topupPoolAfterProfit = addMoney(
        bucket.balance.topupPoolAfterProfit,
        subMoney(txn.amount, profit.romelaPulaProfit)
      );
      bucket.balance.netCreditedToWallets = addMoney(
        bucket.balance.netCreditedToWallets,
        subMoney(txn.amount, addMoney(profit.ycFee, profit.romelaPulaProfit))
      );
    } else if (txn.type === 'send' || txn.type === 'invoice_payment') {
      addToBucket(bucket.moneyOut, txn.amount, channel);
    }

    addToProfit(bucket.profit, profit);
  }

  for (const wallet of wallets || []) {
    if (!userByPhone[wallet.phone]) continue;
    const bucket = ensureCurrency(byCurrency, wallet.currency);
    bucket.balance.userWalletLiabilities = addMoney(
      bucket.balance.userWalletLiabilities,
      wallet.balance
    );
  }

  for (const bucket of Object.values(byCurrency)) {
    bucket.balance.impliedFloat = subMoney(
      bucket.balance.topupPoolAfterProfit,
      bucket.moneyOut.gross
    );
  }

  const exportTransactions = completedInRange.map((t) => mapTransactionRow(t, userByPhone));

  const totals = {
    registeredUsers: (users || []).length,
    completedTransactions: completedInRange.length,
    filteredTransactions: completedInRange.length,
  };

  return {
    byCurrency,
    transactions: exportTransactions.slice(0, 200),
    exportTransactions,
    totals,
    filters: {
      fromLabel: filters.fromLabel || null,
      toLabel: filters.toLabel || null,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function fetchAdminDashboardData(filters = {}) {
  const { supabase } = require('./db');
  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('phone, kyc_name, business_name, display_name, home_currency, kyc_status')
    .eq('kyc_status', 'approved');

  if (usersErr) throw new Error(usersErr.message);

  const phones = (users || []).map((u) => u.phone);
  if (phones.length === 0) {
    return buildDashboardFromData({ users: [], transactions: [], wallets: [], filters });
  }

  let txnQuery = supabase
    .from('transactions')
    .select('*')
    .in('phone', phones)
    .order('created_at', { ascending: false });

  if (filters.from) txnQuery = txnQuery.gte('created_at', filters.from.toISOString());
  if (filters.to) txnQuery = txnQuery.lte('created_at', filters.to.toISOString());

  const { data: transactions, error: txnErr } = await txnQuery.limit(5000);

  if (txnErr) throw new Error(txnErr.message);

  const { data: wallets, error: walletErr } = await supabase
    .from('wallets')
    .select('phone, currency, balance')
    .in('phone', phones);

  if (walletErr) throw new Error(walletErr.message);

  return buildDashboardFromData({ users, transactions, wallets, filters });
}

module.exports = {
  computeTxnProfit,
  buildDashboardFromData,
  fetchAdminDashboardData,
  formatMoney,
  channelLabel,
  typeLabel,
};
