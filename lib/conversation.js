const crypto = require('crypto');
const { supabase } = require('./db');
const yc = require('./yellowcard');
const { sendWhatsApp } = require('./whatsapp');
const { buildInvoicePaymentQuote } = require('./fees');
const { getPublicAppUrl } = require('./app-url');
const {
  formatSendQuoteMessage,
  isQuoteExpired,
  isQuoteExpiredError,
  QUOTE_EXPIRED_MSG,
  buildDomesticSendFee,
  buildCrossBorderEstimate,
  buildInvoiceWalletBridge,
  formatDomesticFeeMessage,
  formatCrossBorderQuoteMessage,
  buildTopupFee,
  formatTopupFeeNotice,
  formatTopupSettlementMessage,
} = require('./quotes');
const {
  claimTopupCredit,
  claimSendComplete,
  claimSendRefund,
  markTopupFailed,
} = require('./settlement');
const { deliverSendReceipt, SEND_COMPLETE } = require('./receipt-delivery');
const {
  topupMomoNumberPrompt,
  isUseWhatsappShortcut,
  formatWhatsappMomoConfirm,
  isAffirmative,
  isNegative,
  formatNetworkPickerPrompt,
  parseNetworkChoice,
  formatMomoTopupSuccessMessage,
} = require('./topup-momo');
const { MOMO_LABEL, channelLabel, channelLabelInline } = require('./labels');

const WELCOME = `Welcome to *PayLink* 👋
Cross-border money transfer & invoice settlement.

1️⃣ Register
2️⃣ Help`;

const MAIN_MENU_BUSINESS = `What would you like to do?

1️⃣ Pay Invoice (pay a supplier)
2️⃣ Send money to bank or ${MOMO_LABEL}
3️⃣ Top-up Balance
4️⃣ Check Balance
5️⃣ Check invoice / transaction status
6️⃣ Transaction History
7️⃣ Create Invoice`;

const MAIN_MENU_INDIVIDUAL = `What would you like to do?

1️⃣ Send money to bank or ${MOMO_LABEL}
2️⃣ Top-up Balance
3️⃣ Check Balance
4️⃣ Transaction History`;

function getMainMenu(accountType) {
  return accountType === 'business' ? MAIN_MENU_BUSINESS : MAIN_MENU_INDIVIDUAL;
}

// Kept for backwards compatibility with anything referencing the old export name.
const MAIN_MENU = MAIN_MENU_BUSINESS;

// Supported corridors — derived from lib/yellowcard.js COUNTRY_CONFIG.
const COUNTRY_DISPLAY_NAMES = Object.fromEntries(
  Object.entries(yc.COUNTRY_CONFIG).map(([code, cfg]) => [code, cfg.name])
);

function supportedRegistrationCountriesMessage() {
  const corridors = yc.getRegisterableCorridors();
  const lines = corridors.map(
    (c) => `• *+${yc.COUNTRY_CONFIG[c.country].dialCode}* — ${c.name} (${c.currency})`
  );
  return (
    `PayLink is available for WhatsApp numbers from these countries:\n` +
    `${lines.join('\n')}\n\n` +
    `Please use a WhatsApp account registered with one of these country codes.`
  );
}

function paylinkCorridorSummary() {
  const count = yc.getRegisterableCorridors().length;
  return `PayLink lets you pay invoices and send money across ${count} African countries.`;
}

/** User-facing copy when the payments backend is down — never mention third-party providers. */
function paylinkUnavailableMsg() {
  return 'PayLink is temporarily unavailable for this transaction. Please wait a moment and try again, or reply *menu*.';
}

function paylinkPartnerError(err, retryHint = 'Reply *menu* to try again.') {
  const msg = String(err?.message || '');
  if (err?.status >= 500 || err?.status === 429 || msg.includes('timed out')) {
    return paylinkUnavailableMsg();
  }
  return `PayLink couldn't complete this step right now. ${retryHint}`;
}

function unsupportedRegistrationBlockedMessage() {
  return (
    `Sorry — your WhatsApp number is not from a supported country.\n\n` +
    supportedRegistrationCountriesMessage()
  );
}

/** Reset KYC for users whose WhatsApp dial code is outside supported corridors. */
async function deregisterUnsupportedUser(phone, user) {
  if (!user || yc.isSupportedWhatsAppNumber(phone)) return user;

  const alreadyClear =
    user.kyc_status === 'unregistered' &&
    !user.kyc_name &&
    !user.home_currency;
  if (alreadyClear) return user;

  console.log(`[USER] De-registering unsupported WhatsApp number: ${phone}`);

  const { data: updated } = await supabase
    .from('users')
    .update({
      kyc_status: 'unregistered',
      kyc_name: null,
      kyc_dob: null,
      kyc_address: null,
      kyc_id_type: null,
      kyc_id_number: null,
      kyc_email: null,
      home_currency: null,
      home_country: null,
      business_name: null,
      account_type: 'individual',
    })
    .eq('phone', phone)
    .select()
    .single();

  await supabase.from('sessions').delete().eq('phone', phone);

  return updated || {
    ...user,
    kyc_status: 'unregistered',
    kyc_name: null,
    kyc_dob: null,
    kyc_address: null,
    kyc_id_type: null,
    kyc_id_number: null,
    kyc_email: null,
    home_currency: null,
    home_country: null,
    business_name: null,
    account_type: 'individual',
  };
}

/** Persist home wallet country/currency and ensure a zero-balance wallet row exists. */
async function setUserHomeWallet(phone, country, currency) {
  const { data: updated, error } = await supabase
    .from('users')
    .update({ home_currency: currency, home_country: country })
    .eq('phone', phone)
    .select()
    .single();

  if (error) {
    console.error(`[USER] Failed to persist home_currency for ${phone}:`, error.message);
  }

  await supabase.from('wallets').upsert(
    { phone, currency, balance: 0 },
    { onConflict: 'phone,currency', ignoreDuplicates: true }
  );

  await supabase.from('wallets').delete()
    .eq('phone', phone)
    .neq('currency', currency)
    .eq('balance', 0);

  return updated || { phone, home_currency: currency, home_country: country };
}

function channelTypesFor(country) {
  return yc.COUNTRY_CONFIG[country]?.channelTypes || [];
}

function sendChannelTypesFor(country) {
  return yc.COUNTRY_CONFIG[country]?.sendChannelTypes || yc.COUNTRY_CONFIG[country]?.channelTypes || [];
}

async function getSession(phone) {
  const { data } = await supabase.from('sessions').select('*').eq('phone', phone).single();
  if (data) return data;
  const { data: created } = await supabase
    .from('sessions')
    .insert({ phone, state: 'idle', context: {} })
    .select()
    .single();
  return created;
}

async function setSession(phone, state, context = {}) {
  await supabase.from('sessions').upsert({ phone, state, context, updated_at: new Date().toISOString() });
}

/**
 * Every user's wallet currency is derived from their WhatsApp dial code
 * (e.g. +267... => BWP). Backfilled here for existing supported numbers.
 */
async function backfillUserHomeCurrency(phone, user) {
  if (!user || user.home_currency) return user;

  const detected = yc.detectCountryFromNumber(phone);
  if (!detected) return user;

  return setUserHomeWallet(phone, detected.country, detected.currency).then((row) => {
    if (row && typeof row === 'object' && row.phone) return { ...user, ...row };
    return { ...user, home_currency: detected.currency, home_country: detected.country };
  });
}

/** The user's single home-currency wallet — created if missing. */
async function getOrEnsureHomeWallet(phone, user) {
  const currency = user?.home_currency;
  if (!currency) return null;

  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('phone', phone)
    .eq('currency', currency)
    .maybeSingle();

  if (wallet) return wallet;

  const { data: created } = await supabase
    .from('wallets')
    .upsert({ phone, currency, balance: 0 }, { onConflict: 'phone,currency' })
    .select()
    .single();

  return created;
}

async function getOrCreateUser(phone) {
  let { data } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (!data) {
    ({ data } = await supabase.from('users').insert({ phone }).select().single());
  }
  data = await deregisterUnsupportedUser(phone, data);
  return backfillUserHomeCurrency(phone, data);
}


/**
 * Poll Yellow Card for this user's pending topups, sends, and undelivered receipts.
 * Runs at the start of every inbound message. Global settlement + PDF receipts
 * for users who never message again rely on GET /api/poll-transactions (cron).
 */
async function settlePending(phone) {
  try {
    const { data: byStatus } = await supabase
      .from('transactions')
      .select('*')
      .eq('phone', phone)
      .not('status', 'in', '("completed","failed")')
      .in('type', ['topup', 'send', 'invoice_payment']);

    // Recovery: YC complete + txn marked completed but wallet never credited (RPC race / old guard)
    const { data: uncreditedTopups } = await supabase
      .from('transactions')
      .select('*')
      .eq('phone', phone)
      .eq('type', 'topup')
      .eq('wallet_credited', false)
      .neq('status', 'failed');

    // Recovery: send completed on YC/DB but PDF receipt never delivered
    const { data: pendingReceipts } = await supabase
      .from('transactions')
      .select('*')
      .eq('phone', phone)
      .in('type', ['send', 'invoice_payment'])
      .eq('status', 'completed')
      .eq('receipt_sent', false);

    const seen = new Set();
    const pending = [];
    for (const txn of [...(byStatus || []), ...(uncreditedTopups || []), ...(pendingReceipts || [])]) {
      if (!seen.has(txn.id)) {
        seen.add(txn.id);
        pending.push(txn);
      }
    }

    if (pending.length === 0) return;
    console.log(`[SETTLE] ${pending.length} pending transaction(s) for ${phone}`);

    for (const txn of pending) {
      try {
        if (txn.status === 'completed' && !txn.receipt_sent && txn.type !== 'topup') {
          await deliverSendReceipt(txn);
        } else {
          await (txn.type === 'topup' ? settleTopup(txn) : settleSend(txn));
        }
      } catch (err) {
        console.warn(`[SETTLE] Error on txn ${txn.id}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[SETTLE] error:', err.message);
  }
}

async function settleTopup(txn) {
  const ycData = await yc.getReceive(txn.yellowcard_reference);
  const ycStatus = (ycData?.status || '').toUpperCase();
  console.log(`[SETTLE] topup ${txn.id} ycStatus=${ycStatus}`);

  if (['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL', 'SETTLED'].includes(ycStatus)) {
    try {
      const result = await claimTopupCredit(txn.id, ycData);
      if (!result.claimed) {
        console.warn(
          `[SETTLE] topup ${txn.id} YC=${ycStatus} but wallet not credited (claimed=false). ` +
          `Check transactions.wallet_credited and that claim_topup_credit exists in Supabase — run db/schema.sql.`
        );
        return;
      }

      console.log(`[SETTLE] ✅ Topup credited ${result.netAmount} ${result.currency} (gross ${result.amount}, fee ${result.feeAmount}) — balance ${result.newBalance}`);
      sendWhatsApp(txn.phone,
        formatTopupSettlementMessage({
          grossAmount: result.amount,
          netAmount: result.netAmount,
          feeAmount: result.feeAmount,
          currency: result.currency,
          newBalance: result.newBalance,
        })
      ).catch((e) => console.error('[SETTLE] Topup notify failed:', e.message));
    } catch (err) {
      console.error(
        `[SETTLE] claim_topup_credit failed for ${txn.id}:`,
        err.message,
        '— Deploy settlement RPCs from db/schema.sql in Supabase SQL editor (wallet_credited column + claim_topup_credit).'
      );
      throw err;
    }

  } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(ycStatus)) {
    const result = await markTopupFailed(txn.id, ycData);
    if (!result.claimed) return;
    console.log(`[SETTLE] ❌ Topup ${txn.id} failed (${ycStatus})`);
    sendWhatsApp(txn.phone,
      `⚠️ Your top-up of *${result.amount} ${result.currency}* could not be completed. Please reply *menu* to try again.`
    ).catch((e) => console.error('[SETTLE] Topup fail notify failed:', e.message));
  }
}

async function settleSend(txn) {
  const ycData = await yc.getSend(txn.yellowcard_reference);
  const ycStatus = (ycData?.status || '').toUpperCase();
  console.log(`[SETTLE] send ${txn.id} ycStatus=${ycStatus}`);

  if (SEND_COMPLETE.includes(ycStatus)) {
    const result = await claimSendComplete(txn.id, ycData);
    if (!result.claimed) {
      const { data: fresh } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
      if (fresh?.status === 'completed' && !fresh.receipt_sent) {
        await deliverSendReceipt(fresh);
      }
      return;
    }

    console.log(`[SETTLE] ✅ Send ${txn.id} completed`);

    if (result.invoiceId) {
      await supabase.from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', result.invoiceId);
    }

    if (result.receiptPending) {
      const { data: fresh } = await supabase.from('transactions').select('*').eq('id', txn.id).single();
      const receipt = await deliverSendReceipt(fresh || txn);
      if (!receipt.sent) {
        console.warn(`[SETTLE] Receipt not delivered for send ${txn.id}: ${receipt.reason}`);
      }
    }

  } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(ycStatus)) {
    const result = await claimSendRefund(txn.id, ycData);
    if (!result.claimed) return;

    console.log(`[SETTLE] ↩️ Refunded ${result.amount} ${result.currency} to ${result.phone}`);
    sendWhatsApp(result.phone,
      `⚠️ Your transfer of *${result.amount} ${result.currency}* to ${txn.recipient_name} failed (${ycStatus.toLowerCase()}). Your balance has been refunded. Reply *menu* to try again.`
    ).catch((e) => console.error('[SETTLE] Refund notify failed:', e.message));
  }
}

/**
 * Main entry point. mediaRefs is an array of inbound media references
 * (Twilio media URL or PWA ref web:{uuid}) on this message, or [].
 */
async function handleIncomingMessage(phone, text, mediaRefs = []) {
  // Must await — Vercel freezes the function after the TwiML response is sent;
  // fire-and-forget settlement never delivered PDF receipts.
  await settlePending(phone);

  const user = await getOrCreateUser(phone);
  const session = await getSession(phone);
  const msg = (text || '').trim();
  const lower = msg.toLowerCase();

  if (!yc.isSupportedWhatsAppNumber(phone)) {
    await setSession(phone, 'idle', {});
    if (msg === '2' || lower === 'help') {
      return (
        `${supportedRegistrationCountriesMessage()}\n\n` +
        paylinkCorridorSummary()
      );
    }
    return unsupportedRegistrationBlockedMessage();
  }

  const csw = require('./customer-service-window');
  if (csw.isPwaActivationKeyword(lower)) {
    await csw.activatePwa(phone);
    return csw.buildPwaActivationReply();
  }

  if (['hi', 'hello', 'menu', 'start'].includes(lower)) {
    return routeHome(phone, user);
  }

  switch (session.state) {
    case 'idle':
      return routeHome(phone, user, msg);

    // Registration
    case 'welcome_choice':
      return handleWelcomeChoice(phone, msg);
    case 'register_account_type':
      return handleRegisterAccountType(phone, msg, session);
    case 'register_business_name':
      return handleRegisterBusinessName(phone, msg, session);
    case 'register_name':
      return handleRegisterName(phone, msg, session);
    case 'register_dob':
      return handleRegisterDob(phone, msg, session);
    case 'register_address':
      return handleRegisterAddress(phone, msg, session);
    case 'register_id':
      return handleRegisterId(phone, msg, session);
    case 'register_email':
      return handleRegisterEmail(phone, msg, session);
    case 'register_documents':
      return handleRegisterDocuments(phone, msg, session, mediaRefs);

    // Pay supplier / send money (shared flow, `purpose` in context distinguishes them)
    case 'txn_recipient_name':
      return handleTxnRecipientName(phone, msg, session);
    case 'txn_channel_choice':
      return handleTxnChannelChoice(phone, msg, session);
    case 'txn_recipient_account':
      return handleTxnRecipientAccount(phone, msg, session);
    case 'txn_currency':
      return handleTxnCurrency(phone, msg, session);
    case 'txn_recipient_confirm':
      return handleTxnRecipientConfirm(phone, msg, session);
    case 'txn_amount':
      return handleTxnAmount(phone, msg, session);
    case 'txn_quote_confirm':
      return handleTxnQuoteConfirm(phone, msg, session);
    case 'txn_reference':
      return handleTxnReference(phone, msg, session);

    // Top-up
    case 'invoice_pay_code':
      return handleInvoicePayCode(phone, msg, session);
    case 'invoice_pay_country':
      return handleInvoicePayCountry(phone, msg, session);
    case 'invoice_pay_channel_choice':
      return handleInvoicePayChannelChoice(phone, msg, session);
    case 'invoice_pay_account':
      return handleInvoicePayAccount(phone, msg, session);
    case 'invoice_pay_recipient_confirm':
      return handleInvoicePayRecipientConfirm(phone, msg, session);
    case 'topup_channel_choice':
      return handleTopupChannelChoice(phone, msg, session);
    case 'topup_amount':
      return handleTopupAmount(phone, msg, session);
    case 'topup_account_number':
      return handleTopupAccountNumber(phone, msg, session);
    case 'topup_whatsapp_confirm':
      return handleTopupWhatsappConfirm(phone, msg, session);
    case 'topup_network_choice':
      return handleTopupNetworkChoice(phone, msg, session);

    // Status / history
    case 'status_lookup':
      return handleStatusLookup(phone, msg);

    // Create invoice
    case 'invoice_create_currency':
      return handleInvoiceCreateCurrency(phone, msg, session);
    case 'invoice_create_amount':
      return handleInvoiceCreateAmount(phone, msg, session);
    case 'invoice_create_description':
      return handleInvoiceCreateDescription(phone, msg, session);

    default:
      await setSession(phone, 'idle', {});
      return routeHome(phone, user);
  }
}

// ─── Individual menu actions (numbered 1-4 on that menu) ───────────────────
async function actionSendMoney(phone) {
  await setSession(phone, 'txn_recipient_name', { purpose: 'send' });
  return "What's the recipient's name?";
}

async function actionTopup(phone) {
  const user = await getOrCreateUser(phone);
  if (!user.home_currency || !user.home_country) {
    return `We couldn't work out your wallet currency from your WhatsApp number. If you're using a number outside our supported countries, contact support to set your home currency.`;
  }
  const ctx = { currency: user.home_currency, country: user.home_country };
  const activeChannels = channelTypesFor(user.home_country);

  if (activeChannels.length === 0) {
    return `Sorry, top-up is not available for ${user.home_currency} right now. Please contact support.`;
  }
  if (activeChannels.length > 1) {
    await setSession(phone, 'topup_channel_choice', { ...ctx, activeChannels });
    const opts = activeChannels.map((c, i) => `${i + 1}️⃣ ${channelLabel(c)}`).join('\n');
    return `Top up your *${user.home_currency}* wallet via:\n${opts}`;
  }
  await setSession(phone, 'topup_amount', { ...ctx, channelType: activeChannels[0] });
  return `How much would you like to top up to your *${user.home_currency}* wallet? Enter just the number.`;
}

async function actionCheckBalance(phone) {
  await settlePending(phone);
  const user = await getOrCreateUser(phone);
  if (!user.home_currency) {
    return `We couldn't work out your wallet currency from your WhatsApp number. If you're using a number outside our supported countries, contact support to set your home currency.`;
  }
  const wallet = await getOrEnsureHomeWallet(phone, user);
  await setSession(phone, 'idle', {});
  const balance = wallet ? parseFloat(wallet.balance) : 0;
  return `*${user.home_currency}:* ${balance.toFixed(2)}`;
}

async function actionTransactionHistory(phone) {
  await settlePending(phone);
  const history = await handleTransactionHistory(phone);
  await setSession(phone, 'idle', {});
  return history;
}

async function handleInvoicePayCode(phone, msg, session) {
  if (msg.trim().toLowerCase() === 'skip') {
    await setSession(phone, 'txn_recipient_name', { purpose: 'invoice_payment' });
    return "What's the supplier's name?";
  }
  const code = msg.trim().toUpperCase();
  const { data: invoice } = await supabase
    .from('invoices').select('*').eq('invoice_code', code).maybeSingle();
  if (!invoice) {
    return `Invoice *${code}* not found. Check the code and try again, or reply *skip* to enter details manually.`;
  }
  if (invoice.status === 'paid') {
    return `Invoice *${code}* has already been paid.`;
  }

  let supplierName = 'Supplier';
  if (invoice.issuer_phone) {
    const { data: issuer } = await supabase
      .from('users')
      .select('kyc_name, business_name')
      .eq('phone', invoice.issuer_phone)
      .maybeSingle();
    supplierName = issuer?.business_name || issuer?.kyc_name || supplierName;
  }

  // Pre-fill the transaction context from the invoice
  let country = invoice.country || yc.defaultCountryForCurrency(invoice.currency);
  if (!country) {
    await setSession(phone, 'invoice_pay_country', {
      purpose: 'invoice_payment',
      invoiceCode: code,
      invoiceId: invoice.id,
      recipientName: supplierName,
      currency: invoice.currency,
      amount: parseFloat(invoice.amount),
    });
    const summary = `Invoice *${code}*:\n*${invoice.amount} ${invoice.currency}*\n${invoice.description || ''}`;
    return (
      `${summary}\n\n` +
      yc.formatCorridorPickerPrompt(
        `This invoice uses *${invoice.currency}*, which is shared by several countries. Which country is the supplier in?`,
        { currency: invoice.currency }
      )
    );
  }
  const ctx = {
    purpose: 'invoice_payment',
    invoiceCode: code,
    invoiceId: invoice.id,
    recipientName: supplierName,
    currency: invoice.currency,
    country,
    amount: parseFloat(invoice.amount),
  };
  const summary = `Invoice *${code}*:\n*${invoice.amount} ${invoice.currency}*\n${invoice.description || ''}`;
  const allowed = sendChannelTypesFor(country);

  // Still need to know how the supplier gets paid (bank vs mobile money)
  // and their account number before we can submit the payout.
  if (allowed.length === 1) {
    // Only one channel type is available for this currency — skip the choice.
    await setSession(phone, 'invoice_pay_account', { ...ctx, channelType: allowed[0] });
    const label = allowed[0] === 'bank' ? "supplier's bank account number" : `supplier's ${MOMO_LABEL} number`;
    return `${summary}\n\nWhat's the ${label}?`;
  }
  await setSession(phone, 'invoice_pay_channel_choice', ctx);
  return `${summary}\n\nPay via:\n1️⃣ Bank transfer\n2️⃣ ${MOMO_LABEL}`;
}

async function handleInvoicePayCountry(phone, msg, session) {
  const corridor = yc.parseCorridorPickerChoice(msg, { currency: session.context.currency });
  if (!corridor) {
    return (
      `Please reply with a valid number from the list.\n\n` +
      yc.formatCorridorPickerPrompt(
        `Which country is the supplier in? (invoice currency: *${session.context.currency}*)`,
        { currency: session.context.currency }
      )
    );
  }

  const ctx = {
    ...session.context,
    country: corridor.country,
    currency: corridor.currency,
  };
  const summary = `Invoice *${ctx.invoiceCode}*:\n*${ctx.amount} ${ctx.currency}* (${corridor.name})`;
  const allowed = sendChannelTypesFor(corridor.country);

  if (allowed.length === 1) {
    await setSession(phone, 'invoice_pay_account', { ...ctx, channelType: allowed[0] });
    const label = allowed[0] === 'bank' ? "supplier's bank account number" : `supplier's ${MOMO_LABEL} number`;
    return `${summary}\n\nWhat's the ${label}?`;
  }
  await setSession(phone, 'invoice_pay_channel_choice', ctx);
  return `${summary}\n\nPay via:\n1️⃣ Bank transfer\n2️⃣ ${MOMO_LABEL}`;
}

async function handleInvoicePayChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return `Please reply 1 for bank transfer or 2 for ${MOMO_LABEL}.`;

  const allowed = sendChannelTypesFor(session.context.country);
  if (!allowed.includes(channelType)) {
    const allowedLabel = allowed.map((c) => channelLabelInline(c)).join(' or ');
    return `${session.context.currency} only supports ${allowedLabel}. Please choose again.`;
  }
  await setSession(phone, 'invoice_pay_account', { ...session.context, channelType });
  return channelType === 'bank' ? "Supplier's bank account number?" : `Supplier's ${MOMO_LABEL} number?`;
}

/**
 * Live invoice quote from YC: true send fee (get-config) + /business/rates FX
 * bridge, with PayLink markups/margins bundled into the customer Fees line.
 */
async function buildInvoicePayoutCtx({ ctx, user }) {
  if (!ctx.country || !ctx.currency || !ctx.channelType) {
    throw new Error('Missing supplier country or payment method — reply *menu* and try again');
  }

  console.log('[INVOICE] buildInvoicePayoutCtx:', JSON.stringify({
    country: ctx.country,
    currency: ctx.currency,
    channelType: ctx.channelType,
    payoutAmount: ctx.amount,
    walletCurrency: user.home_currency,
  }));

  const feeQuote = await buildInvoicePaymentQuote({
    payoutAmount: ctx.amount,
    currency: ctx.currency,
    country: ctx.country,
    channelType: ctx.channelType,
  });

  const walletCurrency = user.home_currency || ctx.currency;
  const isCrossCurrency = walletCurrency !== ctx.currency;

  let debitAmount = feeQuote.totalCharge;
  let bridge = null;
  if (isCrossCurrency) {
    bridge = await buildInvoiceWalletBridge({
      accountType: user.account_type,
      walletCurrency,
      invoiceCurrency: ctx.currency,
      invoiceCountry: ctx.country,
      invoiceTotal: feeQuote.totalCharge,
    });
    debitAmount = bridge.walletAmount;
  }

  const rateQuote = await yc.getConversionQuote({
    txType: 'send',
    localAmount: feeQuote.payoutAmount,
    currency: ctx.currency,
    country: ctx.country,
    channelType: ctx.channelType,
  });

  return {
    ...ctx,
    payoutAmount: feeQuote.payoutAmount,
    ycFeeAmount: feeQuote.ycFeeAmount,
    markupAmount: feeQuote.markupAmount,
    amount: debitAmount,
    walletCurrency,
    quoteId: rateQuote.quoteId,
    quoteExpiresAt: rateQuote.expiresAt,
    ycPayoutRate: rateQuote.rate,
    ...(bridge ? {
      fxBridgeRate1: bridge.rate1,
      fxBridgeRate2: bridge.rate2,
      fxBridgedRate: bridge.bridgedRate,
      fxBridgeMarginPct: bridge.marginPct,
      fxBridgeDisplayRate: bridge.displayRate,
    } : {}),
  };
}

function invoiceQuoteFromCtx(ctx) {
  return { quoteId: ctx.quoteId, expiresAt: ctx.quoteExpiresAt };
}

async function handleInvoicePayAccount(phone, msg, session) {
  const ctx = session.context;
  const recipientAccountNumber = ctx.channelType === 'momo'
    ? yc.toInternationalPhone(msg.trim(), ctx.country)
    : msg.trim();

  try {
    const resolution = await resolveRecipientIdentity({ channelType: ctx.channelType, country: ctx.country, accountNumber: recipientAccountNumber });
    if (resolution.notFound) {
      return `We couldn't find an account matching that number. Please double-check it and try again.`;
    }
    const nextCtx = {
      ...ctx,
      recipientAccountNumber,
      ...(resolution.name ? { recipientName: resolution.name } : {}),
    };
    await setSession(phone, 'invoice_pay_recipient_confirm', nextCtx);
    return formatRecipientConfirmMessage(nextCtx, resolution, 'supplier');
  } catch (err) {
    console.error('[RESOLVE] Invoice recipient identity check failed:', err.message);
    return paylinkPartnerError(err);
  }
}

async function handleInvoicePayRecipientConfirm(phone, msg, session) {
  const ctx = session.context;
  const choice = msg.trim().toLowerCase();

  if (choice === '2' || choice === 'no') {
    await setSession(phone, 'invoice_pay_account', ctx);
    return ctx.channelType === 'bank' ? "Supplier's bank account number?" : `Supplier's ${MOMO_LABEL} number?`;
  }
  if (choice !== '1' && choice !== 'yes' && choice !== 'confirm') {
    return 'Please reply *1* to confirm this is the correct recipient, or *2* if it isn\'t.';
  }

  try {
    const user = await getOrCreateUser(phone);
    const feeCtx = await buildInvoicePayoutCtx({ ctx, user });

    const { data: wallet } = await supabase
      .from('wallets').select('balance')
      .eq('phone', phone).eq('currency', feeCtx.walletCurrency).single();
    const balance = wallet ? parseFloat(wallet.balance) : 0;
    if (balance < feeCtx.amount) {
      await setSession(phone, 'idle', {});
      return `Insufficient balance for this invoice.\n\nYou need *${feeCtx.amount.toFixed(2)} ${feeCtx.walletCurrency}* (incl. fees) but only have *${balance.toFixed(2)} ${feeCtx.walletCurrency}*.\n\nReply *menu* → Top-up Balance to add funds.`;
    }

    await setSession(phone, 'txn_quote_confirm', feeCtx);
    return formatSendQuoteMessage(feeCtx, invoiceQuoteFromCtx(feeCtx));
  } catch (err) {
    console.error('[INVOICE] Quote error:', err);
    return paylinkPartnerError(err, 'Reply *menu* to try again.');
  }
}

// ─── Business-only menu actions ────────────────────────────────────────────
async function actionPayInvoice(phone) {
  await setSession(phone, 'invoice_pay_code', { purpose: 'invoice_payment' });
  return "Enter the invoice code to pay (e.g. INV-ABC123), or reply *skip* to enter supplier details manually.";
}

async function actionStatusLookup(phone) {
  await setSession(phone, 'status_lookup', {});
  return 'Enter the transaction reference or invoice code to check.';
}

async function actionCreateInvoice(phone) {
  await setSession(phone, 'invoice_create_currency', {});
  return yc.formatCorridorPickerPrompt('Which country / currency is this invoice for?');
}

// Menu number -> action, kept separate per account type since the numbering differs.
const BUSINESS_MENU_ACTIONS = {
  '1': actionPayInvoice,
  '2': actionSendMoney,
  '3': actionTopup,
  '4': actionCheckBalance,
  '5': actionStatusLookup,
  '6': actionTransactionHistory,
  '7': actionCreateInvoice,
};

const INDIVIDUAL_MENU_ACTIONS = {
  '1': actionSendMoney,
  '2': actionTopup,
  '3': actionCheckBalance,
  '4': actionTransactionHistory,
};

async function routeHome(phone, user, msg) {
  if (user.kyc_status === 'unregistered' || user.kyc_status === 'rejected') {
    if (msg === '1') {
      await setSession(phone, 'register_account_type', {});
      return 'Are you registering as an *individual* or a *business*? Reply "individual" or "business".';
    }
    if (msg === '2') {
      await setSession(phone, 'idle', {});
      return `${paylinkCorridorSummary()} Reply "1" to register and get started.`;
    }
    await setSession(phone, 'welcome_choice', {});
    return WELCOME;
  }

  if (user.kyc_status === 'pending_review') {
    return "Your registration is still under review. We'll message you here as soon as it's approved — usually within 1 business day.";
  }

  // approved — dispatch main menu number choices, using the menu that matches account type
  if (msg) {
    const actions = user.account_type === 'business' ? BUSINESS_MENU_ACTIONS : INDIVIDUAL_MENU_ACTIONS;
    const action = actions[msg.trim()];
    if (action) return action(phone);
  }

  await setSession(phone, 'idle', {});
  return getMainMenu(user.account_type);
}

async function handleWelcomeChoice(phone, msg) {
  const user = await getOrCreateUser(phone);
  return routeHome(phone, user, msg);
}

// ============================================================
// Registration / KYC
// ============================================================

async function handleRegisterAccountType(phone, msg, session) {
  const type = msg.trim().toLowerCase();
  if (!['individual', 'business'].includes(type)) {
    return 'Please reply "individual" or "business".';
  }
  if (type === 'business') {
    await setSession(phone, 'register_business_name', { ...session.context, accountType: type });
    return "What's your business name?";
  }
  await setSession(phone, 'register_name', { ...session.context, accountType: type });
  return "What's your full name?";
}

async function handleRegisterBusinessName(phone, msg, session) {
  await setSession(phone, 'register_name', { ...session.context, businessName: msg.trim() });
  return "What's the full name of the business owner / authorized representative?";
}

async function handleRegisterName(phone, msg, session) {
  await setSession(phone, 'register_dob', { ...session.context, name: msg.trim() });
  return 'Date of birth? (mm/dd/yyyy)';
}

async function handleRegisterDob(phone, msg, session) {
  const raw = msg.trim();
  // Accept mm/dd/yyyy or dd/mm/yyyy — just validate it's a plausible date
  const dateRegex = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/;
  if (!dateRegex.test(raw)) {
    return 'Please enter your date of birth in dd/mm/yyyy format, e.g. 15/03/1990.';
  }
  await setSession(phone, 'register_address', { ...session.context, dob: raw });
  return 'Home or business address? (street + city is fine)';
}

async function handleRegisterAddress(phone, msg, session) {
  await setSession(phone, 'register_id', { ...session.context, address: msg.trim() });
  return 'ID type and number? (e.g. "National ID 123456" or "Passport A1234567" — for a business, use a company registration number)';
}

async function handleRegisterId(phone, msg, session) {
  const parts = msg.trim().split(' ');
  if (parts.length < 2) {
    return 'Please include both the ID type and number, e.g. "National ID 123456789" or "Passport A1234567".';
  }
  const idNumber = parts.pop();
  const idType = parts.join(' ');
  if (idNumber.length < 4) {
    return 'That ID number looks too short. Please include the full number, e.g. "National ID 123456789".';
  }
  await setSession(phone, 'register_email', { ...session.context, idType, idNumber });
  return 'Email address?';
}

async function handleRegisterEmail(phone, msg, session) {
  const email = msg.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'Please enter a valid email address, e.g. name@example.com.';
  }
  const { getDocumentRequirementsMessage } = require('./email');
  const accountType = session.context.accountType || 'individual';

  await setSession(phone, 'register_documents', {
    ...session.context,
    email,
    documentUrls: [],
  });

  return getDocumentRequirementsMessage(accountType);
}

async function handleRegisterDocuments(phone, msg, session, mediaRefs) {
  const ctx = session.context;
  const collected = ctx.documentUrls || [];

  if (mediaRefs.length > 0) {
    const updated = { ...ctx, documentUrls: [...collected, ...mediaRefs] };
    await setSession(phone, 'register_documents', updated);
    return `Got it (${updated.documentUrls.length} document(s) so far). Send more, or reply "done" when finished.`;
  }

  if (msg.trim().toLowerCase() === 'done') {
    if (collected.length === 0) {
      return "You haven't sent any documents yet — please attach at least one, then reply \"done\".";
    }
    return finalizeRegistration(phone, ctx, collected);
  }

  return 'Please attach a document, or reply "done" if you\'ve sent everything.';
}

async function finalizeRegistration(phone, ctx, documentUrls) {
  await setSession(phone, 'idle', {});

  const detected = yc.detectCountryFromNumber(phone);
  const homeUpdate = detected
    ? { home_country: detected.country, home_currency: detected.currency }
    : {};

  await supabase
    .from('users')
    .update({
      account_type:  ctx.accountType,
      business_name: ctx.businessName || null,
      kyc_status:    'pending_review',
      kyc_name:      ctx.name,
      kyc_dob:       ctx.dob,
      kyc_address:   ctx.address,
      kyc_id_type:   ctx.idType,
      kyc_id_number: ctx.idNumber,
      kyc_email:     ctx.email,
      ...homeUpdate,
    })
    .eq('phone', phone);

  if (homeUpdate.home_currency) {
    await setUserHomeWallet(phone, homeUpdate.home_country, homeUpdate.home_currency);
  }

  const { data: submission } = await supabase
    .from('kyc_submissions')
    .insert({
      phone,
      document_urls: documentUrls,
      note: ctx.previousNote || null,
    })
    .select()
    .single();

  // Download docs and attach to email
  const { downloadWhatsAppMedia } = require('./whatsapp-media');
  const { sendKycReviewEmail }  = require('./email');

  try {
    const attachments = [];
    for (const url of documentUrls) {
      try {
        const { base64, filename } = await downloadWhatsAppMedia(url);
        attachments.push({ filename, content: base64 });
      } catch (e) {
        console.error('Failed to download a document, skipping:', e);
      }
    }

    await sendKycReviewEmail({
      phone,
      accountType:  ctx.accountType,
      businessName: ctx.businessName,
      kycName:      ctx.name,
      kycDob:       ctx.dob,
      kycAddress:   ctx.address,
      kycIdType:    ctx.idType,
      kycIdNumber:  ctx.idNumber,
      kycEmail:     ctx.email,
      attachments,
      approvalToken: submission.approval_token,
      previousNote: ctx.previousNote || null,
    });
  } catch (err) {
    console.error('Failed to send KYC review email:', err);
  }

  return (
    `✅ *Documents submitted!*\n\n` +
    `Thank you — your verification is now under review.\n` +
    `We'll message you here within 1 business day.\n\n` +
    `If we need anything else, we'll reach out to you directly.`
  );
}

// ============================================================
// Pay invoice (to a supplier) / Send money — shared flow.
// purpose: 'invoice_payment' | 'send'
// ============================================================

async function handleTxnRecipientName(phone, msg, session) {
  await setSession(phone, 'txn_channel_choice', { ...session.context, recipientName: msg.trim() });
  return `Send via:\n1️⃣ Bank transfer\n2️⃣ ${MOMO_LABEL}`;
}

async function handleTxnChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return `Please reply 1 for bank transfer or 2 for ${MOMO_LABEL}.`;

  // Validate against known currency (if already chosen) or defer to amount step
  // Currency is chosen after channel, so we validate at currency selection instead.
  await setSession(phone, 'txn_recipient_account', { ...session.context, channelType });
  return channelType === 'bank' ? "Recipient's bank account number?" : `Recipient's ${MOMO_LABEL} number?`;
}

/**
 * The bot must NEVER blindly execute a payout. Before any send/invoice
 * payment is submitted, resolve the recipient's registered account name
 * and make the sender explicitly confirm it.
 *
 * Yellow Card only exposes account-name resolution for BANK accounts
 * (POST /business/details/bank) — there is no equivalent endpoint for
 * mobile money. For momo, we can't independently verify the name, so we
 * fall back to an explicit manual confirmation of the name the sender
 * already gave us — still a hard confirm gate, just not API-verified.
 */
async function resolveRecipientIdentity({ channelType, country, accountNumber }) {
  if (channelType !== 'bank') {
    return { verifiable: false };
  }
  // Bank resolution is only guaranteed for a handful of countries on Yellow
  // Card's side. If the lookup itself is unavailable/errors for this
  // corridor (as opposed to a genuinely bad account number), fail soft into
  // the manual-confirm path instead of blocking sends entirely.
  try {
    const networks = await yc.getNetworks(country, 'bank');
    const network = yc.pickPreferredNetwork(networks);
    if (!network) {
      return { verifiable: false };
    }
    const result = await yc.resolveBankAccount({ accountNumber, networkId: network.id });
    if (!result?.accountName) {
      return { verifiable: false };
    }
    return { verifiable: true, name: result.accountName, bank: result.accountBank, networkId: network.id };
  } catch (err) {
    if (yc.isAccountNotFoundError(err)) {
      return { verifiable: true, notFound: true };
    }
    console.error('[RESOLVE] Bank account resolution unavailable, falling back to manual confirm:', err.message);
    return { verifiable: false };
  }
}

function formatRecipientConfirmMessage(ctx, resolution, recipientLabel = 'recipient') {
  if (resolution.name) {
    return (
      `We found this account:\n\n*${resolution.name}*${resolution.bank ? ` (${resolution.bank})` : ''}\n\n` +
      `Is this the correct ${recipientLabel}?\n1️⃣ Yes\n2️⃣ No, re-enter the account number`
    );
  }
  return (
    `⚠️ We can't independently verify ${MOMO_LABEL} account names for this corridor yet.\n\n` +
    `You're sending to:\n*${ctx.recipientName}*\n${ctx.recipientAccountNumber}\n\n` +
    `Please confirm this is the correct ${recipientLabel}:\n1️⃣ Yes\n2️⃣ No, re-enter the number`
  );
}

async function handleTxnRecipientAccount(phone, msg, session) {
  const ctx = session.context;
  const accountNumber = msg.trim();

  // Momo numbers carry a country code, so we can deduce the recipient's
  // country/currency automatically instead of asking. Bank account numbers
  // don't, so that path still asks manually (see handleTxnCurrency below).
  if (ctx.channelType === 'momo') {
    const detected = yc.detectSendCorridorFromNumber(accountNumber);
    if (!detected) {
      const supported = Object.values(yc.COUNTRY_CONFIG)
        .filter((c) => c.channelTypes.includes('momo'))
        .map((c) => `+${c.dialCode} (${c.currency})`)
        .join(', ');
      return `We couldn't recognise that ${MOMO_LABEL} number. We currently support ${MOMO_LABEL} sends to: ${supported}. Please check the number (include the country code) and try again, or reply *menu* to go back.`;
    }
    if (!sendChannelTypesFor(detected.country).includes('momo')) {
      return `${detected.currency} doesn't support ${MOMO_LABEL} for sends yet. Please use a bank transfer instead, or reply *menu* to go back.`;
    }
    const normalised = yc.toInternationalPhone(accountNumber, detected.country);
    const nextCtx = {
      ...ctx,
      recipientAccountNumber: normalised,
      currency: detected.currency,
      country: detected.country,
    };
    try {
      const resolution = await resolveRecipientIdentity({ channelType: 'momo', country: detected.country, accountNumber: normalised });
      await setSession(phone, 'txn_recipient_confirm', nextCtx);
      return formatRecipientConfirmMessage(nextCtx, resolution);
    } catch (err) {
      console.error('[RESOLVE] Momo identity check failed:', err.message);
      return paylinkPartnerError(err);
    }
  }

  // Bank — country/currency can't be inferred from the account number, so keep the manual pick.
  await setSession(phone, 'txn_currency', { ...ctx, recipientAccountNumber: accountNumber });
  return yc.formatCorridorPickerPrompt('Which country is the recipient in?');
}

async function handleTxnCurrency(phone, msg, session) {
  const corridor = yc.parseCorridorPickerChoice(msg);
  if (!corridor) {
    return (
      `Please reply with a valid number from the list.\n\n` +
      yc.formatCorridorPickerPrompt('Which country is the recipient in?')
    );
  }
  const currency = corridor.currency;
  const country = corridor.country;
  const allowed = sendChannelTypesFor(country);
  const { channelType, recipientAccountNumber } = session.context;
  if (channelType && !allowed.includes(channelType)) {
    const allowedLabel = allowed.map((c) => channelLabelInline(c)).join(' or ');
    return `${currency} only supports ${allowedLabel}. Please reply *menu* and start again choosing the correct channel.`;
  }

  try {
    const resolution = await resolveRecipientIdentity({ channelType, country, accountNumber: recipientAccountNumber });
    if (resolution.notFound) {
      return `We couldn't find an account matching that number. Please double-check the account number and try again.`;
    }
    const nextCtx = {
      ...session.context,
      currency,
      country,
      ...(resolution.name ? { recipientName: resolution.name } : {}),
    };
    await setSession(phone, 'txn_recipient_confirm', nextCtx);
    return formatRecipientConfirmMessage(nextCtx, resolution);
  } catch (err) {
    console.error('[RESOLVE] Bank identity check failed:', err.message);
    return paylinkPartnerError(err);
  }
}

async function handleTxnRecipientConfirm(phone, msg, session) {
  const ctx = session.context;
  const choice = msg.trim().toLowerCase();

  if (choice === '2' || choice === 'no') {
    await setSession(phone, 'txn_recipient_account', {
      purpose: ctx.purpose,
      recipientName: ctx.recipientName,
      channelType: ctx.channelType,
    });
    return ctx.channelType === 'bank' ? "Recipient's bank account number?" : `Recipient's ${MOMO_LABEL} number?`;
  }

  if (choice !== '1' && choice !== 'yes' && choice !== 'confirm') {
    return 'Please reply *1* to confirm this is the correct recipient, or *2* if it isn\'t.';
  }

  await setSession(phone, 'txn_amount', ctx);
  const user = await getOrCreateUser(phone);
  const walletCurrency = user.home_currency;
  const wallet = await getOrEnsureHomeWallet(phone, user);
  const balance = wallet ? parseFloat(wallet.balance) : 0;
  const balanceLine = `Your current balance: *${balance.toFixed(2)} ${walletCurrency}*`;
  const verb = ctx.purpose === 'invoice_payment' ? 'pay' : 'send';
  const isCrossBorder = ctx.currency && walletCurrency && ctx.currency !== walletCurrency;
  if (isCrossBorder && ctx.purpose === 'invoice_payment') {
    return (
      `How much should *${ctx.recipientName || 'the supplier'}* receive in *${ctx.currency}*?\n\n${balanceLine}`
    );
  }
  if (isCrossBorder) {
    return `How much would you like to ${verb} in total from your *${walletCurrency}* wallet?\n\n${balanceLine}`;
  }
  return `How much would you like to ${verb}? Enter just the number.\n\n${balanceLine}`;
}

const MIN_AMOUNT = 10;
const MAX_AMOUNT = 100000;

async function handleTxnQuoteConfirm(phone, msg, session) {
  const ctx = session.context;
  const lower = msg.trim().toLowerCase();

  if (lower === 'cancel') {
    await setSession(phone, 'idle', {});
    return 'Payment cancelled. Reply *menu* to go back.';
  }

  // Plain "send money" — new fee model (no live-quote lock/refresh loop;
  // the real FX quote is only locked immediately before submitSend).
  if (ctx.purpose === 'send') {
    if (lower !== 'confirm') {
      return ctx.displayRate != null ? formatCrossBorderQuoteMessage(ctx) : formatDomesticFeeMessage(ctx);
    }
    return finalizeTransaction(phone, ctx, null);
  }

  // Invoice payment — existing live-quote system, unchanged.
  if (lower === '1') {
    try {
      const user = await getOrCreateUser(phone);
      const feeCtx = await buildInvoicePayoutCtx({ ctx, user });
      await setSession(phone, 'txn_quote_confirm', feeCtx);
      return `🔄 *Quote refreshed*\n\n${formatSendQuoteMessage(feeCtx, invoiceQuoteFromCtx(feeCtx))}`;
    } catch (err) {
      console.error('[QUOTE] Refresh failed:', err);
      return paylinkPartnerError(err, 'Reply *1* to try again or *cancel*.');
    }
  }

  if (isQuoteExpired({ expiresAt: ctx.quoteExpiresAt })) {
    return QUOTE_EXPIRED_MSG;
  }

  if (lower !== 'confirm') {
    return formatSendQuoteMessage(ctx, invoiceQuoteFromCtx(ctx));
  }

  const reference = ctx.invoiceCode || ctx.reference || null;
  return finalizeTransaction(phone, ctx, reference);
}

async function handleTxnAmount(phone, msg, session) {
  const txnCtx = session.context;

  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }
  if (amount < MIN_AMOUNT) return `Minimum transaction amount is ${MIN_AMOUNT}. Please enter a larger amount.`;
  if (amount > MAX_AMOUNT) return `Maximum transaction amount is ${MAX_AMOUNT}. Please contact support for larger transfers.`;

  const user = await getOrCreateUser(phone);

  // Manual invoice payment — POBO fee quote + live FX quote
  if (txnCtx.purpose === 'invoice_payment' && !txnCtx.invoiceCode) {
    try {
      const feeCtx = await buildInvoicePayoutCtx({ ctx: { ...txnCtx, amount }, user });

      const { data: wallet } = await supabase
        .from('wallets').select('balance')
        .eq('phone', phone).eq('currency', feeCtx.walletCurrency).single();
      const balance = wallet ? parseFloat(wallet.balance) : 0;
      if (balance < feeCtx.amount) {
        await setSession(phone, 'idle', {});
        return `Insufficient balance.\n\nYou need *${feeCtx.amount.toFixed(2)} ${feeCtx.walletCurrency}* (incl. fees) but only have *${balance.toFixed(2)} ${feeCtx.walletCurrency}*. Reply *menu* → Top-up Balance.`;
      }

      await setSession(phone, 'txn_reference', feeCtx);
      return `${formatSendQuoteMessage(feeCtx, invoiceQuoteFromCtx(feeCtx))}\n\nWhat payment reference should this invoice show? (e.g. invoice number)`;
    } catch (err) {
      console.error('[INVOICE] Manual quote error:', err);
      return paylinkPartnerError(err);
    }
  }

  // Plain "send money" — always debited from the user's one home-currency
  // wallet, regardless of which currency the recipient ends up receiving.
  const walletCurrency = user.home_currency;
  if (!walletCurrency || !user.home_country) {
    return `We couldn't work out your wallet currency from your WhatsApp number. If you're using a number outside our supported countries, contact support to set your home currency.`;
  }

  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('phone', phone)
    .eq('currency', walletCurrency)
    .single();
  const balance = wallet ? parseFloat(wallet.balance) : 0;

  const isDomestic = txnCtx.currency === walletCurrency;

  try {
    if (isDomestic) {
      const fee = await buildDomesticSendFee({
        country: user.home_country,
        currency: walletCurrency,
        channelType: txnCtx.channelType,
        amount,
      });
      const totalDebit = parseFloat((amount + fee.totalFee).toFixed(2));
      if (balance < totalDebit) {
        await setSession(phone, 'idle', {});
        return `Please add funds in your account. You need *${totalDebit.toFixed(2)} ${walletCurrency}* (incl. fees) but your balance is *${balance.toFixed(2)} ${walletCurrency}*. Reply "3" from the menu to top up.`;
      }
      const sendCtx = {
        ...txnCtx,
        sourceAmount: amount,
        payoutAmount: amount,
        ycFeeAmount: fee.ycFeeAmount,
        markupAmount: fee.markupAmount,
        amount: totalDebit,
        walletCurrency,
      };
      await setSession(phone, 'txn_quote_confirm', sendCtx);
      return formatDomesticFeeMessage(sendCtx);
    }

    // Cross-border — user enters total wallet debit (fees included).
    const estimate = await buildCrossBorderEstimate({
      accountType: user.account_type,
      sourceCurrency: walletCurrency,
      sourceCountry: user.home_country,
      destCurrency: txnCtx.currency,
      destCountry: txnCtx.country,
      channelType: txnCtx.channelType,
      totalDebit: amount,
    });
    if (balance < amount) {
      await setSession(phone, 'idle', {});
      return `Please add funds in your account. You need *${amount.toFixed(2)} ${walletCurrency}* but your balance is *${balance.toFixed(2)} ${walletCurrency}*. Reply "3" from the menu to top up.`;
    }
    const sendCtx = {
      ...txnCtx,
      sourceAmount: estimate.principalFx,
      payoutAmount: estimate.destAmountEstimate,
      ycFeeAmount: estimate.ycFeeAmount,
      markupAmount: estimate.markupAmount,
      displayRate: estimate.displayRate,
      marginPct: estimate.marginPct,
      amount: amount,
      walletCurrency,
    };
    await setSession(phone, 'txn_quote_confirm', sendCtx);
    return formatCrossBorderQuoteMessage(sendCtx);
  } catch (err) {
    console.error('[SEND FEE] Error building quote:', err);
    return paylinkPartnerError(err);
  }
}

async function handleTxnReference(phone, msg, session) {
  const ctx = { ...session.context, reference: msg.trim() };
  if (isQuoteExpired({ expiresAt: ctx.quoteExpiresAt })) {
    await setSession(phone, 'txn_quote_confirm', ctx);
    return QUOTE_EXPIRED_MSG;
  }
  await setSession(phone, 'txn_quote_confirm', ctx);
  if (ctx.purpose === 'invoice_payment') {
    return formatSendQuoteMessage(ctx, invoiceQuoteFromCtx(ctx));
  }
  return formatSendQuoteMessage(ctx, {
    quoteId: ctx.quoteId,
    ycRate: ctx.ycRate,
    displayRate: ctx.displayRate,
    marginPct: ctx.marginPct,
    usdAmount: ctx.quoteUsdAmount,
    usdDisplay: parseFloat(ctx.payoutAmount || ctx.amount) / ctx.displayRate,
    expiresAt: ctx.quoteExpiresAt,
  });
}

async function safeDebitWallet(phone, currency, amount) {
  // Read current balance
  const { data: wallet } = await supabase
    .from('wallets')
    .select('balance')
    .eq('phone', phone)
    .eq('currency', currency)
    .single();

  const current = wallet ? parseFloat(wallet.balance) : 0;
  if (current < amount) {
    throw new Error('INSUFFICIENT_FUNDS');
  }

  const newBalance = parseFloat((current - amount).toFixed(2));

  const { error } = await supabase
    .from('wallets')
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq('phone', phone)
    .eq('currency', currency)
    .eq('balance', wallet.balance); // optimistic lock — fails if balance changed

  if (error) {
    throw new Error('WALLET_UPDATE_CONFLICT — please try again');
  }
}

async function finalizeTransaction(phone, ctx, reference) {
  await setSession(phone, 'idle', {});
  const user = await getOrCreateUser(phone);
  // ctx.country is the DESTINATION country (where the payout happens) — set
  // during recipient-account/currency entry. ctx.walletCurrency is the
  // SENDER's home wallet currency, which is what actually gets
  // debited/refunded — it can differ from ctx.currency (destination /
  // invoice currency) for cross-border sends and cross-currency invoices.
  const country = ctx.country || yc.defaultCountryForCurrency(ctx.currency);
  const isInvoice = ctx.purpose === 'invoice_payment';
  const isPlainSend = ctx.purpose === 'send';
  const walletCurrency = ctx.walletCurrency || ctx.currency;
  const debitAmount = parseFloat(ctx.amount);
  const payoutAmount = parseFloat(ctx.payoutAmount || ctx.amount);
  let walletDebited = false;

  if (ctx.quoteId && isQuoteExpired({ expiresAt: ctx.quoteExpiresAt })) {
    await setSession(phone, 'txn_quote_confirm', ctx);
    return QUOTE_EXPIRED_MSG;
  }

  try {
    const networks = await yc.getNetworks(country, ctx.channelType);
    if (!networks || networks.length === 0) {
      return `I couldn't find an active ${ctx.channelType} network for ${country} right now. Please try again shortly — your balance hasn't been touched.`;
    }
    const preferredNetwork = networks.find((n) =>
      ['myzaka', 'orange', 'mascom', 'btc'].some((k) => n.name?.toLowerCase().includes(k))
    ) || networks[0];
    const networkId = preferredNetwork.id;

    // YC locks the payout rate on submitSend (~10 min window) — no separate
    // pre-quote API call. Cross-border estimates shown earlier use /business/rates.

    await safeDebitWallet(phone, walletCurrency, debitAmount);
    walletDebited = true;

    const sequenceId = `${isInvoice ? 'INV' : 'SEND'}-${crypto.randomUUID()}`;

    // Sender KYC always reflects the sender's OWN home country/phone format —
    // not the destination country, which can differ for cross-border sends.
    const senderCountry = user.home_country || country;
    const sender = {
      name: user.kyc_name || user.business_name || 'PayLink User',
      country: senderCountry,
      phone: yc.toInternationalPhone(phone, senderCountry),
      address: user.kyc_address || 'Address on file',
      dob: user.kyc_dob || '01/01/1990',
      email: user.kyc_email || 'noreply@paylink.app',
      idNumber: user.kyc_id_number || '000000',
      idType: user.kyc_id_type || 'national_id',
    };

    const reason = isInvoice ? 'bills' : 'other';

    const send = await yc.submitSend({
      sequenceId,
      localAmount: payoutAmount,
      country,
      currency: ctx.currency,
      channelType: ctx.channelType,
      reason,
      customerUID: phone.replace(/\D/g, ''),
      sender,
      destination: {
        accountName: ctx.recipientName,
        accountNumber: ctx.recipientAccountNumber,
        accountType: ctx.channelType,
        networkId,
        country,
      },
    });
    console.log('[SEND] submitSend response:', JSON.stringify(send));

    const { data: txn, error: insertErr } = await supabase.from('transactions').insert({
      type: ctx.purpose,
      phone,
      invoice_id: ctx.invoiceId || null,
      amount: debitAmount,
      payout_amount: payoutAmount,
      payout_currency: walletCurrency !== ctx.currency ? ctx.currency : null,
      yc_fee_amount: ctx.ycFeeAmount || 0,
      markup_amount: ctx.markupAmount || 0,
      currency: walletCurrency,
      status: 'pending',
      reference,
      recipient_name: ctx.recipientName,
      recipient_account_number: ctx.recipientAccountNumber,
      recipient_channel_type: ctx.channelType,
      yellowcard_reference: send.id,
      quote_id: ctx.quoteId || null,
      yc_rate: ctx.fxBridgeDisplayRate != null ? null : (ctx.ycRate || null),
      display_rate: ctx.fxBridgeDisplayRate != null ? ctx.fxBridgeDisplayRate : (ctx.displayRate || null),
      margin_pct: ctx.fxBridgeMarginPct != null ? ctx.fxBridgeMarginPct : (ctx.marginPct || null),
      quote_expires_at: ctx.quoteExpiresAt || null,
      raw_response: send,
    }).select().single();
    if (insertErr) console.error('[SEND] Failed to insert transaction:', insertErr.message);
    else if (txn) {
      console.log(`[SEND] Transaction saved — yellowcard_reference=${send.id} ycStatus=${send.status}`);
      try { await settleSend(txn); } catch (e) { console.warn('[SEND] Immediate settle failed:', e.message); }
    }

    const label = isInvoice ? 'Invoice payment' : 'Transfer';
    const feeNote = (isInvoice || isPlainSend)
      ? (walletCurrency !== ctx.currency
        ? `\n(Recipient receives ${payoutAmount} ${ctx.currency}; ${debitAmount} ${walletCurrency} debited, fees included)`
        : `\n(Recipient receives ${payoutAmount} ${ctx.currency}; ${debitAmount} ${walletCurrency} debited incl. fees)`)
      : '';
    return `✅ ${label} of ${payoutAmount} ${ctx.currency} to ${ctx.recipientName} initiated. Reference: ${send.id}${feeNote}\n\n⏳ Your wallet has been debited. We're processing the payout — you'll receive a PDF receipt here once it's confirmed.\n\nReply *menu* anytime to refresh status.`;
  } catch (err) {
    console.error('Transaction error:', err);
    if (isQuoteExpiredError(err)) {
      await setSession(phone, 'txn_quote_confirm', ctx);
      return QUOTE_EXPIRED_MSG;
    }
    if (err.message === 'INSUFFICIENT_FUNDS') {
      return `❌ Insufficient balance. Your ${walletCurrency} balance is too low for this transaction. Reply "3" from the menu to top up.`;
    }
    if (err.message.startsWith('WALLET_UPDATE_CONFLICT')) {
      return `❌ Your balance changed during this transaction — likely a concurrent payment. Please try again.`;
    }
    if (walletDebited) {
      await supabase
        .from('wallets')
        .select('balance')
        .eq('phone', phone)
        .eq('currency', walletCurrency)
        .single()
        .then(async ({ data: w }) => {
          if (w) {
            await supabase.from('wallets').update({
              balance: parseFloat(w.balance) + debitAmount,
              updated_at: new Date().toISOString(),
            }).eq('phone', phone).eq('currency', walletCurrency);
          }
        });
      return `❌ Payment failed after debiting your wallet. Your ${walletCurrency} ${debitAmount} has been refunded. Please try again.`;
    }
    return `❌ Something went wrong. Your balance has not been charged. Please try again or reply "menu".`;
  }
}

// ============================================================
// Top-up Balance
// ============================================================

async function handleTopupChannelChoice(phone, msg, session) {
  const choice = parseInt(msg.trim(), 10);
  const activeChannels = session.context.activeChannels || ['bank', 'momo'];
  const channelType = activeChannels[choice - 1];
  if (!channelType) {
    const opts = activeChannels.map((c, i) => `${i + 1} for ${channelLabelInline(c)}`).join(' or ');
    return `Please reply ${opts}.`;
  }
  await setSession(phone, 'topup_amount', { ...session.context, channelType });
  return 'How much would you like to top up? Enter just the number.';
}

async function handleTopupAmount(phone, msg, session) {
  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }
  if (amount < MIN_AMOUNT) return `Minimum top-up amount is ${MIN_AMOUNT}. Please enter a larger amount.`;
  if (amount > MAX_AMOUNT) return `Maximum top-up amount is ${MAX_AMOUNT}. Please contact support for larger amounts.`;

  const ctx2 = { ...session.context, amount };
  let feeQuote;
  try {
    feeQuote = await buildTopupFee({
      country: ctx2.country,
      currency: ctx2.currency,
      channelType: ctx2.channelType,
      amount,
    });
  } catch (e) {
    console.error('[TOPUP] fee quote failed:', e.message);
    return "Sorry, I couldn't calculate the top-up fee right now. Please try again or contact support.";
  }

  if (feeQuote.netCredit <= 0) {
    return `The top-up amount is too low after fees. Please enter a larger amount.`;
  }

  const ctx3 = {
    ...ctx2,
    ycFeeAmount: feeQuote.ycFeeAmount,
    markupAmount: feeQuote.markupAmount,
    topupFee: feeQuote.totalFee,
    netCredit: feeQuote.netCredit,
  };
  const feeNotice = formatTopupFeeNotice(ctx3);

  if (ctx3.channelType === 'bank') {
    await setSession(phone, 'topup_account_number', { ...ctx3, skipAccountNumber: true });
    return `You're about to top up *${amount} ${ctx3.currency}* via bank transfer.\n\n${feeNotice}\n\nPlease reply *confirm* to proceed, or *cancel* to go back.`;
  }

  await setSession(phone, 'topup_account_number', ctx3);
  return `${feeNotice}\n\n${topupMomoNumberPrompt({ country: ctx3.country, currency: ctx3.currency, whatsappPhone: phone })}`;
}

function topupSessionBase(ctx) {
  const { momoAccountNumber, momoNetworks, ...base } = ctx;
  return base;
}

async function proceedToTopupMomoNetworks(phone, ctx, momoAccountNumber) {
  try {
    const networks = await yc.getNetworks(ctx.country, 'momo');
    console.log(`[TOPUP] getNetworks(${ctx.country}, momo) returned ${networks.length} result(s):`, JSON.stringify(networks));

    if (!networks || networks.length === 0) {
      await setSession(phone, 'idle', {});
      console.error(`[TOPUP] No active networks for ${ctx.country}/momo — cannot submit receive`);
      return `Sorry, mobile payments aren't available for your country right now. Please contact support or reply 'menu'.`;
    }

    if (networks.length === 1) {
      return submitTopupReceive(phone, ctx, { momoAccountNumber, networkId: networks[0].id });
    }

    const momoNetworks = networks.map((n) => ({ id: n.id, name: n.name }));
    await setSession(phone, 'topup_network_choice', { ...ctx, momoAccountNumber, momoNetworks });
    return formatNetworkPickerPrompt(networks);
  } catch (err) {
    console.error('[TOPUP] getNetworks error:', err.message);
    await setSession(phone, 'idle', {});
    return `Sorry, I couldn't load ${MOMO_LABEL} providers right now. Please reply 'menu' to try again.`;
  }
}

async function handleTopupAccountNumber(phone, msg, session) {
  const ctx = session.context;

  if (ctx.skipAccountNumber) {
    if (msg.trim().toLowerCase() === 'cancel') {
      await setSession(phone, 'idle', {});
      return `Top-up cancelled. Reply *menu* to start over.`;
    }
    if (msg.trim().toLowerCase() !== 'confirm') {
      return `Please reply *confirm* to proceed with the bank top-up, or *cancel* to go back.`;
    }
    return submitTopupReceive(phone, ctx);
  }

  if (isUseWhatsappShortcut(msg)) {
    const momoAccountNumber = yc.toInternationalPhone(phone, ctx.country);
    await setSession(phone, 'topup_whatsapp_confirm', { ...ctx, momoAccountNumber });
    return formatWhatsappMomoConfirm(momoAccountNumber);
  }

  const momoAccountNumber = yc.toInternationalPhone(msg.trim(), ctx.country);
  return proceedToTopupMomoNetworks(phone, ctx, momoAccountNumber);
}

async function handleTopupWhatsappConfirm(phone, msg, session) {
  const ctx = session.context;

  if (isAffirmative(msg)) {
    return proceedToTopupMomoNetworks(phone, ctx, ctx.momoAccountNumber);
  }
  if (isNegative(msg)) {
    await setSession(phone, 'topup_account_number', topupSessionBase(ctx));
    return topupMomoNumberPrompt({ country: ctx.country, currency: ctx.currency, whatsappPhone: phone });
  }
  return formatWhatsappMomoConfirm(ctx.momoAccountNumber);
}

async function handleTopupNetworkChoice(phone, msg, session) {
  const ctx = session.context;
  const networks = ctx.momoNetworks || [];
  const picked = parseNetworkChoice(msg, networks);

  if (!picked) {
    return `Please reply with a number from 1 to ${networks.length}.\n\n${formatNetworkPickerPrompt(networks)}`;
  }

  return submitTopupReceive(phone, ctx, { momoAccountNumber: ctx.momoAccountNumber, networkId: picked.id });
}

async function submitTopupReceive(phone, ctx, momoOpts = null) {
  await setSession(phone, 'idle', {});
  const user = await getOrCreateUser(phone);

  const recipient = {
    name: user.kyc_name || user.business_name,
    country: ctx.country,
    phone: yc.toInternationalPhone(phone, ctx.country),
    address: user.kyc_address,
    dob: user.kyc_dob,
    email: user.kyc_email,
    idNumber: user.kyc_id_number,
    idType: user.kyc_id_type,
  };

  const source = { accountType: ctx.channelType };
  if (ctx.channelType === 'momo' && momoOpts) {
    source.accountNumber = momoOpts.momoAccountNumber;
    source.networkId = momoOpts.networkId;
    console.log(`[TOPUP] Using network id ${momoOpts.networkId} for momo ${source.accountNumber}`);
  } else if (ctx.channelType === 'bank' && yc.isYcSandbox()) {
    source.accountNumber = yc.SANDBOX_BANK_SUCCESS_ACCOUNT;
    console.log(`[TOPUP] Sandbox bank receive — using test payer account ${source.accountNumber}`);
  }

  try {
    console.log(`[TOPUP] submitReceive payload — source:`, JSON.stringify(source), 'recipient.phone:', recipient.phone);

    const receive = await yc.submitReceive({
      sequenceId: `TOPUP-${crypto.randomUUID()}`,
      localAmount: ctx.amount,
      country: ctx.country,
      currency: ctx.currency,
      channelType: ctx.channelType,
      customerUID: phone.replace(/\D/g, ''),
      recipient,
      source,
    });
    console.log(`[TOPUP] submitReceive response:`, JSON.stringify(receive));

    const { data: txn, error: insertErr } = await supabase.from('transactions').insert({
      type: 'topup',
      phone,
      amount: ctx.amount,
      currency: ctx.currency,
      status: 'pending',
      reference: receive.reference || null,
      recipient_channel_type: ctx.channelType,
      yellowcard_reference: receive.id,
      raw_response: receive,
      yc_fee_amount: ctx.ycFeeAmount || 0,
      markup_amount: ctx.markupAmount || 0,
    }).select().single();
    if (insertErr) console.error('[TOPUP] Failed to insert transaction:', insertErr.message);
    else {
      console.log(`[TOPUP] Transaction saved — yellowcard_reference=${receive.id} ycStatus=${receive.status}`);
      try { await settleTopup(txn); } catch (e) { console.warn('[TOPUP] Immediate settle failed:', e.message); }
    }

    if (ctx.channelType === 'bank' && receive.bankInfo) {
      const paymentRef = receive.reference || receive.id;
      const payAmount = receive.convertedAmount || ctx.amount;
      const expiresMins = receive.expiresAt
        ? Math.max(1, Math.ceil((new Date(receive.expiresAt).getTime() - Date.now()) / 60000))
        : null;
      const sandboxNote = yc.isYcSandbox()
        ? `\n\n_🧪 Sandbox: payment is simulated automatically — no real bank transfer needed. Your wallet will update within a few seconds._`
        : '';
      return `To complete your top-up of *${payAmount} ${ctx.currency}*, transfer exactly that amount to:

Bank: ${receive.bankInfo.name}
Account name: ${receive.bankInfo.accountName}
Account number: ${receive.bankInfo.accountNumber}

⚠️ Use this as your *bank payment reference* (required so we can match your transfer):
*${paymentRef}*
${expiresMins ? `\n⏳ Complete within ~${expiresMins} minutes.` : ''}
A top-up fee of *${parseFloat(ctx.topupFee || 0).toFixed(2)} ${ctx.currency}* will be deducted on success (*${parseFloat(ctx.netCredit || ctx.amount).toFixed(2)} ${ctx.currency}* added to your wallet).
Your balance will update automatically once your payment is confirmed.${sandboxNote}`;
    }

    return formatMomoTopupSuccessMessage({
      amount: ctx.amount,
      currency: ctx.currency,
      topupFee: ctx.topupFee,
      netCredit: ctx.netCredit,
      reference: receive.reference || receive.id,
      momoNumber: momoOpts?.momoAccountNumber || source.accountNumber,
      expiresAt: receive.expiresAt,
      sandbox: yc.isYcSandbox(),
    });
  } catch (err) {
    console.error('YellowCard submitReceive (topup) error:', err);
    const errMsg = err.data?.message || err.message || '';
    if (err.status === 504 || errMsg.includes('timed out')) {
      return paylinkUnavailableMsg();
    }
    if (errMsg.includes('No active channel')) {
      return `Sorry, *${channelLabelInline(ctx.channelType)}* top-up is not available right now. Please try a different method or contact support.`;
    }
    if (errMsg.includes('networkId')) {
      return `Sorry, no payment network found for your country. Please contact support.`;
    }
    if (errMsg.includes('phone number') || errMsg.includes('InvalidPhoneNumber')) {
      await setSession(phone, 'topup_account_number', topupSessionBase(ctx));
      return (
        `The number wasn't accepted as a valid *${COUNTRY_DISPLAY_NAMES[ctx.country] || ctx.country}* ${MOMO_LABEL} account.\n\n` +
        `${topupMomoNumberPrompt({ country: ctx.country, currency: ctx.currency, whatsappPhone: phone })}`
      );
    }
    return "I couldn't start the top-up right now. Please reply 'menu' to try again.";
  }
}

// ============================================================
// Status & history
// ============================================================

async function handleStatusLookup(phone, msg) {
  await setSession(phone, 'idle', {});
  const code = msg.trim();

  // Poll Yellow Card before showing status — may complete the txn and send receipt
  await settlePending(phone);

  // Look up by yellowcard_reference (exact match only, parameterised)
  let { data: txnByRef } = await supabase
    .from('transactions')
    .select('*')
    .eq('yellowcard_reference', code)
    .eq('phone', phone)
    .maybeSingle();

  if (txnByRef && !['completed', 'failed'].includes(txnByRef.status)) {
    await (txnByRef.type === 'topup' ? settleTopup(txnByRef) : settleSend(txnByRef));
    ({ data: txnByRef } = await supabase
      .from('transactions')
      .select('*')
      .eq('yellowcard_reference', code)
      .eq('phone', phone)
      .maybeSingle());
  }

  if (txnByRef) {
    return formatTxnStatus(txnByRef);
  }

  // Look up by internal reference field
  const { data: txnByIntRef } = await supabase
    .from('transactions')
    .select('*')
    .eq('reference', code)
    .eq('phone', phone)
    .maybeSingle();

  if (txnByIntRef) {
    return formatTxnStatus(txnByIntRef);
  }

  // Look up invoice by code
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*')
    .eq('invoice_code', code.toUpperCase())
    .maybeSingle();

  if (invoice) {
    const isOwner = invoice.issuer_phone === phone;
    return (
      `🧾 *Invoice ${code.toUpperCase()}*\n` +
      `Status: *${invoice.status.toUpperCase()}*\n` +
      `Amount: ${invoice.amount} ${invoice.currency}\n` +
      `Description: ${invoice.description || '—'}\n` +
      (isOwner ? `Role: You created this invoice` : `Role: Payer`)
    );
  }

  return "I couldn't find anything with that reference. Double-check it, or reply 'menu'.";
}

function formatTxnStatus(t) {
  const typeLabel = { topup: 'Top-up', send: 'Transfer', invoice_payment: 'Invoice payment' };
  const statusEmoji = { completed: '✅', failed: '❌', pending: '⏳', processing: '🔄', created: '🔄' };
  const pendingNote = !['completed', 'failed'].includes(t.status)
    ? `\n\n_Still processing. You'll receive a PDF receipt here once confirmed._`
    : '';
  const payoutCurrency = t.payout_currency || t.currency;
  const isCrossBorderSend = t.type === 'send' && t.payout_amount != null && payoutCurrency !== t.currency;
  const customerFee = (parseFloat(t.yc_fee_amount || 0) + parseFloat(t.markup_amount || 0)).toFixed(2);
  const feeLines = (t.type === 'invoice_payment' || t.type === 'send') && t.payout_amount != null
    ? `Recipient receives: ${parseFloat(t.payout_amount).toFixed(2)} ${payoutCurrency}\n` +
      (isCrossBorderSend
        ? `Total debited: ${parseFloat(t.amount).toFixed(2)} ${t.currency} (fees included)\n` +
          `Fees included in total: ${customerFee} ${t.currency}\n`
        : `Fees: ${customerFee} ${t.currency}\n` +
          `Total debited: ${parseFloat(t.amount).toFixed(2)} ${t.currency}\n`)
    : `Amount: ${parseFloat(t.amount).toFixed(2)} ${t.currency}\n`;
  const rateLine = t.display_rate && payoutCurrency !== t.currency
    ? `FX rate: 1 ${t.currency} = ${parseFloat(t.display_rate).toFixed(4)} ${payoutCurrency}\n`
    : '';
  return (
    `📋 *Transaction Status*\n\n` +
    `Type: ${typeLabel[t.type] || t.type}\n` +
    `Status: ${statusEmoji[t.status] || ''} *${t.status.charAt(0).toUpperCase() + t.status.slice(1)}*\n` +
    feeLines +
    rateLine +
    (t.recipient_name ? `Recipient: ${t.recipient_name}\n` : '') +
    `Reference: ${t.yellowcard_reference || '—'}\n` +
    `Date: ${new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` +
    pendingNote
  );
}

async function handleTransactionHistory(phone) {
  const { data: txns } = await supabase
    .from('transactions')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(5);

  if (!txns || txns.length === 0) return "You don't have any transactions yet.";

  const typeLabel = { topup: '⬇️ Top-up', send: '⬆️ Transfer', invoice_payment: '🧾 Invoice' };
  const statusLabel = { completed: '✅ Completed', failed: '❌ Failed', pending: '⏳ Pending', processing: '🔄 Processing', created: '🔄 Processing' };
  return txns
    .map((t) => {
      const lbl = typeLabel[t.type] || t.type;
      const st = statusLabel[t.status] || t.status;
      const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      return `${date} ${lbl} ${t.amount} ${t.currency} ${st}${t.recipient_name ? ' → ' + t.recipient_name : ''}`;
    })
    .join('\n');
}

// ============================================================
// Create Invoice
// ============================================================

async function handleInvoiceCreateCurrency(phone, msg, session) {
  const corridor = yc.parseCorridorPickerChoice(msg);
  if (!corridor) {
    return (
      `Please reply with a valid number from the list.\n\n` +
      yc.formatCorridorPickerPrompt('Which country / currency is this invoice for?')
    );
  }
  await setSession(phone, 'invoice_create_amount', {
    ...session.context,
    currency: corridor.currency,
    country: corridor.country,
  });
  return `How much is this invoice for in *${corridor.currency}* (${corridor.name})? Enter just the number (e.g. 1500):`;
}

async function handleInvoiceCreateAmount(phone, msg, session) {
  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }
  await setSession(phone, 'invoice_create_description', { ...session.context, amount });
  return 'Enter a short description for this invoice (e.g. "March goods supply", "Consulting fee"):';
}

async function handleInvoiceCreateDescription(phone, msg, session) {
  await setSession(phone, 'idle', {});

  const ctx = session.context;

  // Generate a short readable invoice code
  const invoiceCode = `INV-${Date.now().toString(36).toUpperCase().slice(-6)}`;

  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({
      invoice_code: invoiceCode,
      issuer_phone: phone,
      amount:       ctx.amount,
      currency:     ctx.currency,
      country:      ctx.country || yc.defaultCountryForCurrency(ctx.currency),
      description:  msg.trim(),
      status:       'pending',
    })
    .select()
    .single();

  if (error) {
    console.error('Invoice creation error:', error);
    return "Sorry, I couldn't create the invoice right now. Please try again.";
  }

  return (
    `🧾 *Invoice created!*\n\n` +
    `*Invoice Code:* ${invoiceCode}\n` +
    `*Amount:* ${ctx.amount} ${ctx.currency}\n` +
    `*Description:* ${msg.trim()}\n\n` +
    `Share this code with your customer. They can pay by messaging this WhatsApp number and choosing option 1️⃣ (Pay Invoice).\n\n` +
    `Reply *"menu"* to return to the main menu.`
  );
}

module.exports = {
  handleIncomingMessage,
  MAIN_MENU,
  WELCOME,
  getSession,
  getOrCreateUser,
};