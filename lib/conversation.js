const crypto = require('crypto');
const { supabase } = require('./db');
const yc = require('./yellowcard');
const { sendWhatsApp } = require('./twilio');

const WELCOME = `Welcome to *PayLink* 👋
Cross-border money transfer & invoice settlement.

1️⃣ Register
2️⃣ Help`;

const MAIN_MENU_BUSINESS = `What would you like to do?

1️⃣ Pay Invoice (pay a supplier)
2️⃣ Send money to bank or mobile wallet
3️⃣ Top-up Balance
4️⃣ Check Balance
5️⃣ Check invoice / transaction status
6️⃣ Transaction History
7️⃣ Create Invoice`;

const MAIN_MENU_INDIVIDUAL = `What would you like to do?

1️⃣ Send money to bank or mobile wallet
2️⃣ Top-up Balance
3️⃣ Check Balance
4️⃣ Transaction History`;

function getMainMenu(accountType) {
  return accountType === 'business' ? MAIN_MENU_BUSINESS : MAIN_MENU_INDIVIDUAL;
}

// Kept for backwards compatibility with anything referencing the old export name.
const MAIN_MENU = MAIN_MENU_BUSINESS;

// Currently live on Yellow Card (see README for why Namibia/Zimbabwe are excluded).
const CURRENCY_TO_COUNTRY = { BWP: 'BW', ZAR: 'ZA', ZMW: 'ZM' };
const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_TO_COUNTRY);

function channelTypesFor(country) {
  return yc.COUNTRY_CONFIG[country]?.channelTypes || [];
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

async function getOrCreateUser(phone) {
  const { data } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (data) return data;
  const { data: created } = await supabase.from('users').insert({ phone }).select().single();
  return created;
}

async function getBalances(phone) {
  const { data } = await supabase.from('wallets').select('*').eq('phone', phone);
  return data || [];
}

/**
 * Poll Yellow Card for all of this user's pending topups and sends.
 * Called fire-and-forget at the start of every incoming message so
 * balances and send statuses are always current — no cron needed.
 */
async function settlePending(phone) {
  try {
    // Include any non-terminal status — YC may return "complete" before we credit the wallet
    const { data: pending } = await supabase
      .from('transactions')
      .select('*')
      .eq('phone', phone)
      .not('status', 'in', '("completed","failed")')
      .in('type', ['topup', 'send', 'invoice_payment']);

    if (!pending || pending.length === 0) return;
    console.log(`[SETTLE] ${pending.length} pending transaction(s) for ${phone}`);

    for (const txn of pending) {
      try {
        await (txn.type === 'topup' ? settleTopup(txn) : settleSend(txn));
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
  console.log(`[SETTLE] topup ${txn.id} raw ycData:`, JSON.stringify(ycData));
  const ycStatus = (ycData?.status || '').toUpperCase();
  console.log(`[SETTLE] topup ${txn.id} ycStatus=${ycStatus}`);

  if (['COMPLETE', 'COMPLETED', 'SUCCESS'].includes(ycStatus)) {
    const { data: fresh } = await supabase
      .from('transactions').select('status').eq('id', txn.id).single();
    if (fresh?.status === 'completed') return;

    await supabase.from('transactions').update({
      status: 'completed', updated_at: new Date().toISOString(), raw_response: ycData,
    }).eq('id', txn.id);

    const { data: wallet } = await supabase
      .from('wallets').select('balance')
      .eq('phone', txn.phone).eq('currency', txn.currency).single();
    const prev = parseFloat(wallet?.balance ?? 0);
    const next = prev + parseFloat(txn.amount);
    const { error: upsertErr } = await supabase.from('wallets').upsert(
      { phone: txn.phone, currency: txn.currency, balance: next, updated_at: new Date().toISOString() },
      { onConflict: 'phone,currency' }
    );
    if (upsertErr) {
      console.error(`[SETTLE] ❌ Wallet upsert failed:`, upsertErr.message, upsertErr.details);
    } else {
      console.log(`[SETTLE] ✅ Topup credited ${txn.amount} ${txn.currency} — balance ${prev} → ${next}`);
    }

    sendWhatsApp(txn.phone,
      `✅ Top-up of *${txn.amount} ${txn.currency}* confirmed! Your new balance is *${next} ${txn.currency}*.`
    ).catch((e) => console.error('[SETTLE] Topup notify failed:', e.message));

  } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(ycStatus)) {
    await supabase.from('transactions').update({
      status: 'failed', updated_at: new Date().toISOString(), raw_response: ycData,
    }).eq('id', txn.id);
    console.log(`[SETTLE] ❌ Topup ${txn.id} failed (${ycStatus})`);
    sendWhatsApp(txn.phone,
      `⚠️ Your top-up of *${txn.amount} ${txn.currency}* could not be completed. Please reply *menu* to try again.`
    ).catch((e) => console.error('[SETTLE] Topup fail notify failed:', e.message));
  }
}

async function settleSend(txn) {
  const ycData = await yc.getSend(txn.yellowcard_reference);
  const ycStatus = (ycData?.status || '').toUpperCase();
  console.log(`[SETTLE] send ${txn.id} ycStatus=${ycStatus}`);

  if (['COMPLETE', 'COMPLETED', 'SUCCESS'].includes(ycStatus)) {
    const { data: fresh } = await supabase
      .from('transactions').select('status, receipt_sent').eq('id', txn.id).single();
    if (fresh?.status === 'completed') return;

    await supabase.from('transactions').update({
      status: 'completed', updated_at: new Date().toISOString(), raw_response: ycData,
    }).eq('id', txn.id);
    console.log(`[SETTLE] ✅ Send ${txn.id} completed`);

    if (txn.invoice_id) {
      await supabase.from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', txn.invoice_id);
    }

    // Send receipt PDF as WhatsApp media (guard against duplicate sends if
    // settlePending races with the webhook/poller for the same transaction)
    if (!fresh?.receipt_sent) {
      const base = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
      const receiptUrl = `${base}/api/receipt?id=${txn.id}`;
      const label = txn.type === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
      try {
        await sendWhatsApp(
          txn.phone,
          `✅ *${label} confirmed!*

*${txn.amount} ${txn.currency}* sent to *${txn.recipient_name}*.

Your receipt is attached.`,
          receiptUrl,
        );
        await supabase.from('transactions').update({ receipt_sent: true }).eq('id', txn.id);
      } catch (e) {
        console.error('[SETTLE] Send notify failed:', e.message);
      }
    }

  } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(ycStatus)) {
    // Refund wallet
    const { data: fresh } = await supabase
      .from('transactions').select('status').eq('id', txn.id).single();
    if (fresh?.status === 'failed') return;

    await supabase.from('transactions').update({
      status: 'failed', updated_at: new Date().toISOString(), raw_response: ycData,
    }).eq('id', txn.id);

    // Refund the wallet balance
    const { data: wallet } = await supabase
      .from('wallets').select('balance')
      .eq('phone', txn.phone).eq('currency', txn.currency).single();
    const prev = parseFloat(wallet?.balance ?? 0);
    const refunded = parseFloat((prev + parseFloat(txn.amount)).toFixed(2));

    const { error } = await supabase.from('wallets').upsert(
      { phone: txn.phone, currency: txn.currency, balance: refunded, updated_at: new Date().toISOString() },
      { onConflict: 'phone,currency' }
    );
    if (error) {
      console.error(`[SETTLE] ❌ Refund upsert failed for ${txn.id}:`, error.message);
      return;
    }
    console.log(`[SETTLE] ↩️ Refunded ${txn.amount} ${txn.currency} to ${txn.phone}`);
    sendWhatsApp(txn.phone,
      `⚠️ Your transfer of *${txn.amount} ${txn.currency}* to ${txn.recipient_name} failed (${ycStatus.toLowerCase()}). Your balance has been refunded. Reply *menu* to try again.`
    ).catch((e) => console.error('[SETTLE] Refund notify failed:', e.message));
  }
}

/**
 * Main entry point. mediaUrls is an array of Twilio media URLs present on
 * this message (images/PDFs sent during KYC document upload), or [].
 */
async function handleIncomingMessage(phone, text, mediaUrls = []) {
  // Fire-and-forget: settle any pending topups before handling the message
  // so the user always sees an up-to-date balance. No cron needed.
  settlePending(phone).catch((e) => console.error('[SETTLE] unhandled error:', e.message));

  const user = await getOrCreateUser(phone);
  const session = await getSession(phone);
  const msg = (text || '').trim();
  const lower = msg.toLowerCase();

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
      return handleRegisterDocuments(phone, msg, session, mediaUrls);

    // Pay supplier / send money (shared flow, `purpose` in context distinguishes them)
    case 'txn_recipient_name':
      return handleTxnRecipientName(phone, msg, session);
    case 'txn_channel_choice':
      return handleTxnChannelChoice(phone, msg, session);
    case 'txn_recipient_account':
      return handleTxnRecipientAccount(phone, msg, session);
    case 'txn_currency':
      return handleTxnCurrency(phone, msg, session);
    case 'txn_amount':
      return handleTxnAmount(phone, msg, session);
    case 'txn_reference':
      return handleTxnReference(phone, msg, session);

    // Top-up
    case 'invoice_pay_code':
      return handleInvoicePayCode(phone, msg, session);
    case 'invoice_pay_channel_choice':
      return handleInvoicePayChannelChoice(phone, msg, session);
    case 'invoice_pay_account':
      return handleInvoicePayAccount(phone, msg, session);
    case 'topup_currency':
      return handleTopupCurrency(phone, msg, session);
    case 'topup_channel_choice':
      return handleTopupChannelChoice(phone, msg, session);
    case 'topup_amount':
      return handleTopupAmount(phone, msg, session);
    case 'topup_account_number':
      return handleTopupAccountNumber(phone, msg, session);

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
  await setSession(phone, 'topup_currency', {});
  return `Which currency? Reply with one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
}

async function actionCheckBalance(phone) {
  // Await settle so balance is current before we read it
  await settlePending(phone);
  const balances = await getBalances(phone);
  await setSession(phone, 'idle', {});
  if (balances.length === 0) return 'Your balance is 0 across all currencies.';
  return balances.map((b) => `${b.currency}: ${parseFloat(b.balance).toFixed(2)}`).join('\n');
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
  // Pre-fill the transaction context from the invoice
  const country = CURRENCY_TO_COUNTRY[invoice.currency];
  const ctx = {
    purpose: 'invoice_payment',
    invoiceCode: code,
    invoiceId: invoice.id,
    recipientName: invoice.issuer_phone, // will be shown to user
    currency: invoice.currency,
    country,
    amount: parseFloat(invoice.amount),
  };
  const summary = `Invoice *${code}*:\n*${invoice.amount} ${invoice.currency}*\n${invoice.description || ''}`;
  const allowed = channelTypesFor(country);

  // Still need to know how the supplier gets paid (bank vs mobile money)
  // and their account number before we can submit the payout.
  if (allowed.length === 1) {
    // Only one channel type is available for this currency — skip the choice.
    await setSession(phone, 'invoice_pay_account', { ...ctx, channelType: allowed[0] });
    const label = allowed[0] === 'bank' ? "supplier's bank account number" : "supplier's mobile money number";
    return `${summary}\n\nWhat's the ${label}?`;
  }
  await setSession(phone, 'invoice_pay_channel_choice', ctx);
  return `${summary}\n\nPay via:\n1️⃣ Bank transfer\n2️⃣ Mobile money`;
}

async function handleInvoicePayChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return 'Please reply 1 for bank transfer or 2 for mobile money.';

  const allowed = channelTypesFor(session.context.country);
  if (!allowed.includes(channelType)) {
    const allowedLabel = allowed.map((c) => c === 'bank' ? 'bank transfer' : 'mobile money').join(' or ');
    return `${session.context.currency} only supports ${allowedLabel}. Please choose again.`;
  }
  await setSession(phone, 'invoice_pay_account', { ...session.context, channelType });
  return channelType === 'bank' ? "Supplier's bank account number?" : "Supplier's mobile money number?";
}

async function handleInvoicePayAccount(phone, msg, session) {
  const ctx = session.context;
  const recipientAccountNumber = ctx.channelType === 'momo'
    ? yc.toInternationalPhone(msg.trim(), ctx.country)
    : msg.trim();
  await setSession(phone, 'txn_amount', { ...ctx, recipientAccountNumber });
  return `Reply *confirm* to pay invoice *${ctx.invoiceCode}* (${ctx.amount} ${ctx.currency}), or *cancel* to go back.`;
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
  return `Which currency for this invoice?\nReply with one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
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
      return 'PayLink lets you pay invoices and send money across Botswana, South Africa, and Zambia. Reply "1" to register and get started.';
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
    await setSession(phone, 'register_business_name', { accountType: type });
    return "What's your business name?";
  }
  await setSession(phone, 'register_name', { accountType: type });
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

async function handleRegisterDocuments(phone, msg, session, mediaUrls) {
  const ctx = session.context;
  const collected = ctx.documentUrls || [];

  if (mediaUrls.length > 0) {
    const updated = { ...ctx, documentUrls: [...collected, ...mediaUrls] };
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
    })
    .eq('phone', phone);

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
  const { downloadTwilioMedia } = require('./twilio-media');
  const { sendKycReviewEmail }  = require('./email');

  try {
    const attachments = [];
    for (const url of documentUrls) {
      try {
        const { base64, filename } = await downloadTwilioMedia(url);
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
  return `Send via:\n1️⃣ Bank transfer\n2️⃣ Mobile money`;
}

async function handleTxnChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return 'Please reply 1 for bank transfer or 2 for mobile money.';

  // Validate against known currency (if already chosen) or defer to amount step
  // Currency is chosen after channel, so we validate at currency selection instead.
  await setSession(phone, 'txn_recipient_account', { ...session.context, channelType });
  return channelType === 'bank' ? "Recipient's bank account number?" : "Recipient's mobile money number?";
}

async function handleTxnRecipientAccount(phone, msg, session) {
  const ctx = session.context;
  // Currency/country isn't known yet at this point in the flow (chosen next),
  // so momo numbers are normalised to international format later, in
  // handleTxnCurrency, once we know which country's dial code to use.
  await setSession(phone, 'txn_currency', { ...ctx, recipientAccountNumber: msg.trim() });
  return `Which currency? Reply with one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
}

async function handleTxnCurrency(phone, msg, session) {
  const currency = msg.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return `Please choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
  const country = CURRENCY_TO_COUNTRY[currency];
  const allowed = channelTypesFor(country);
  const { channelType, recipientAccountNumber } = session.context;
  if (channelType && !allowed.includes(channelType)) {
    const allowedLabel = allowed.map((c) => c === 'bank' ? 'bank transfer' : 'mobile money').join(' or ');
    return `${currency} only supports ${allowedLabel}. Please reply *menu* and start again choosing the correct channel.`;
  }
  // Now that the country is known, normalise momo numbers to international format.
  const normalisedAccountNumber = channelType === 'momo'
    ? yc.toInternationalPhone(recipientAccountNumber, country)
    : recipientAccountNumber;
  await setSession(phone, 'txn_amount', {
    ...session.context,
    currency,
    country,
    recipientAccountNumber: normalisedAccountNumber,
  });
  return 'How much would you like to send? Enter just the number.';
}

const MIN_AMOUNT = 10;
const MAX_AMOUNT = 100000;

async function handleTxnAmount(phone, msg, session) {
  const txnCtx = session.context;

  // Invoice lookup flow uses this state to wait for confirm/cancel
  if (txnCtx.invoiceCode && txnCtx.amount) {
    if (msg.trim().toLowerCase() === 'cancel') {
      await setSession(phone, 'idle', {});
      return "Payment cancelled. Reply *menu* to go back.";
    }
    if (msg.trim().toLowerCase() !== 'confirm') {
      return `Reply *confirm* to pay invoice *${txnCtx.invoiceCode}*, or *cancel* to go back.`;
    }
    return finalizeTransaction(phone, txnCtx, txnCtx.invoiceCode);
  }

  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }
  if (amount < MIN_AMOUNT) return `Minimum transaction amount is ${MIN_AMOUNT}. Please enter a larger amount.`;
  if (amount > MAX_AMOUNT) return `Maximum transaction amount is ${MAX_AMOUNT}. Please contact support for larger transfers.`;

  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('phone', phone)
    .eq('currency', session.context.currency)
    .single();

  const balance = wallet ? parseFloat(wallet.balance) : 0;
  if (balance < amount) {
    await setSession(phone, 'idle', {});
    return `Please add funds in your account. Your current balance is ${balance} ${session.context.currency}, which isn't enough for this transaction. Reply "3" from the menu to top up.`;
  }

  const ctx = { ...session.context, amount };
  if (ctx.purpose === 'invoice_payment') {
    await setSession(phone, 'txn_reference', ctx);
    return 'What payment reference should this invoice show? (e.g. invoice number)';
  }
  return finalizeTransaction(phone, ctx, null);
}

async function handleTxnReference(phone, msg, session) {
  return finalizeTransaction(phone, session.context, msg.trim());
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
  const country = CURRENCY_TO_COUNTRY[ctx.currency];
  let walletDebited = false;

  try {
    const networks = await yc.getNetworks(country, ctx.channelType);
    if (!networks || networks.length === 0) {
      return `I couldn't find an active ${ctx.channelType} network for ${country} right now. Please try again shortly — your balance hasn't been touched.`;
    }
    // Prefer a recognisable provider name (same heuristic as top-up) over an
    // arbitrary first result when a country has multiple active networks.
    const preferredNetwork = networks.find((n) =>
      ['myzaka', 'orange', 'mascom', 'btc'].some((k) => n.name?.toLowerCase().includes(k))
    ) || networks[0];
    const networkId = preferredNetwork.id;

    await safeDebitWallet(phone, ctx.currency, ctx.amount);
    walletDebited = true;

    const sequenceId = `${ctx.purpose === 'invoice_payment' ? 'INV' : 'SEND'}-${crypto.randomUUID()}`;
    const send = await yc.submitSend({
      sequenceId,
      localAmount: ctx.amount,
      country,
      currency: ctx.currency,
      channelType: ctx.channelType,
      reason: ctx.purpose === 'invoice_payment' ? 'invoice_settlement' : 'other',
      sender: {
        name: user.kyc_name || user.business_name || 'PayLink User',
        country,
        phone,
      },
      destination: {
        accountName: ctx.recipientName,
        accountNumber: ctx.recipientAccountNumber,
        accountType: ctx.channelType,
        networkId,
      },
    });

    await supabase.from('transactions').insert({
      type: ctx.purpose,
      phone,
      invoice_id: ctx.invoiceId || null,
      amount: ctx.amount,
      currency: ctx.currency,
      status: 'pending',
      reference,
      recipient_name: ctx.recipientName,
      recipient_account_number: ctx.recipientAccountNumber,
      recipient_channel_type: ctx.channelType,
      yellowcard_reference: send.id,
      raw_response: send,
    });

    const label = ctx.purpose === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
    return `✅ ${label} of ${ctx.amount} ${ctx.currency} to ${ctx.recipientName} initiated. Reference: ${send.id}\n\n⏳ Your wallet has been debited. Yellow Card is processing the payout — you'll receive a PDF receipt here once it's confirmed.\n\nReply *menu* anytime to refresh status.`;
  } catch (err) {
    console.error('Transaction error:', err);
    if (err.message === 'INSUFFICIENT_FUNDS') {
      return `❌ Insufficient balance. Your ${ctx.currency} balance is too low for this transaction. Reply "3" from the menu to top up.`;
    }
    if (err.message.startsWith('WALLET_UPDATE_CONFLICT')) {
      return `❌ Your balance changed during this transaction — likely a concurrent payment. Please try again.`;
    }
    // Yellow Card call failed — wallet was already debited, need to refund
    if (walletDebited) {
      await supabase
        .from('wallets')
        .select('balance')
        .eq('phone', phone)
        .eq('currency', ctx.currency)
        .single()
        .then(async ({ data: w }) => {
          if (w) {
            await supabase.from('wallets').update({
              balance: parseFloat(w.balance) + ctx.amount,
              updated_at: new Date().toISOString(),
            }).eq('phone', phone).eq('currency', ctx.currency);
          }
        });
      return `❌ Payment failed after debiting your wallet. Your ${ctx.currency} ${ctx.amount} has been refunded. Please try again.`;
    }
    return `❌ Something went wrong. Your balance has not been charged. Please try again or reply "menu".`;
  }
}

// ============================================================
// Top-up Balance
// ============================================================

async function handleTopupCurrency(phone, msg, session) {
  const currency = msg.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return `Please choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
  const country = CURRENCY_TO_COUNTRY[currency];
  const ctx = { ...session.context, currency, country };

  // Channel support per docs: https://docs.yellowcard.engineering/docs/africa
  // BW=bank+momo, ZA=bank only, ZM=momo only
  const activeChannels = channelTypesFor(country);

  if (activeChannels.length === 0) {
    await setSession(phone, 'idle', {});
    return `Sorry, top-up is not available for ${currency} right now. Please contact support.`;
  }

  if (activeChannels.length > 1) {
    await setSession(phone, 'topup_channel_choice', { ...ctx, activeChannels });
    const opts = activeChannels.map((c, i) => `${i + 1}️⃣ ${c === 'bank' ? 'Bank transfer' : 'Mobile money'}`).join('\n');
    return `Top up via:\n${opts}`;
  }
  await setSession(phone, 'topup_amount', { ...ctx, channelType: activeChannels[0] });
  return 'How much would you like to top up? Enter just the number.';
}

async function handleTopupChannelChoice(phone, msg, session) {
  const choice = parseInt(msg.trim(), 10);
  const activeChannels = session.context.activeChannels || ['bank', 'momo'];
  const channelType = activeChannels[choice - 1];
  if (!channelType) {
    const opts = activeChannels.map((c, i) => `${i + 1} for ${c === 'bank' ? 'bank transfer' : 'mobile money'}`).join(' or ');
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
  await setSession(phone, 'topup_account_number', ctx2);

  if (ctx2.channelType === 'bank') {
    // Bank receives don't need an account number — skip straight to submission
    // by storing a placeholder so handleTopupAccountNumber can proceed
    await setSession(phone, 'topup_account_number', { ...ctx2, skipAccountNumber: true });
    return `You're about to top up *${amount} ${ctx2.currency}* via bank transfer.

Please reply *confirm* to proceed, or *cancel* to go back.`;
  }

  return `What mobile money number will you pay from?

You'll receive a USSD prompt on that number to approve. (Sandbox: 1111111111 success, 0000000000 fail.)`;
}

async function handleTopupAccountNumber(phone, msg, session) {
  const ctx = session.context;

  // Bank flow: user sees a confirm screen instead of entering an account number
  if (ctx.skipAccountNumber) {
    if (msg.trim().toLowerCase() === 'cancel') {
      await setSession(phone, 'idle', {});
      return `Top-up cancelled. Reply *menu* to start over.`;
    }
    if (msg.trim().toLowerCase() !== 'confirm') {
      return `Please reply *confirm* to proceed with the bank top-up, or *cancel* to go back.`;
    }
    // Fall through to submission with no accountNumber (correct per YC docs)
  }

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
  // Docs: accountNumber and networkId are NOT required for bank receives.
  // For momo, accountNumber must be in international format (+COUNTRYCODE...).
  const source = { accountType: ctx.channelType };
  if (ctx.channelType === 'momo') {
    source.accountNumber = yc.toInternationalPhone(msg.trim(), ctx.country);
  }

  try {
    const networks = await yc.getNetworks(ctx.country, ctx.channelType);
    console.log(`[TOPUP] getNetworks(${ctx.country}, ${ctx.channelType}) returned ${networks.length} result(s):`, JSON.stringify(networks));

    if (!networks || networks.length === 0) {
      console.error(`[TOPUP] No active networks for ${ctx.country}/${ctx.channelType} — cannot submit receive`);
      return `Sorry, mobile payments aren't available for your country right now. Please contact support or reply 'menu'.`;
    }

    // For BW momo there may be multiple providers; pick the one whose name matches
    // common aliases the user might recognise, otherwise fall back to first.
    const preferredNetwork = networks.find((n) =>
      ['myzaka', 'orange', 'mascom', 'btc'].some((k) => n.name?.toLowerCase().includes(k))
    ) || networks[0];
    source.networkId = preferredNetwork.id;
    console.log(`[TOPUP] Using network: ${preferredNetwork.name} (${preferredNetwork.id})`);
    console.log(`[TOPUP] submitReceive payload — source:`, JSON.stringify(source), 'recipient.phone:', recipient.phone);

    const receive = await yc.submitReceive({
      sequenceId: `TOPUP-${crypto.randomUUID()}`,
      localAmount: ctx.amount,
      country: ctx.country,
      currency: ctx.currency,
      channelType: ctx.channelType,
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
      recipient_channel_type: ctx.channelType,
      yellowcard_reference: receive.id,
      raw_response: receive,
    }).select().single();
    if (insertErr) console.error('[TOPUP] Failed to insert transaction:', insertErr.message);
    else {
      console.log(`[TOPUP] Transaction saved — yellowcard_reference=${receive.id} ycStatus=${receive.status}`);
      // Sandbox / fast completions: credit immediately instead of waiting for next message
      try { await settleTopup(txn); } catch (e) { console.warn('[TOPUP] Immediate settle failed:', e.message); }
    }

    if (ctx.channelType === 'bank' && receive.bankInfo) {
      return `To complete your top-up of ${ctx.amount} ${ctx.currency}, transfer to:

Bank: ${receive.bankInfo.name}
Account name: ${receive.bankInfo.accountName}
Account number: ${receive.bankInfo.accountNumber}

⚠️ Important: use this as your payment reference so we can match your transfer:
*${receive.id}*

Your balance will update automatically once confirmed.`;
    }

    return `✅ Top-up of ${ctx.amount} ${ctx.currency} initiated via mobile money.\n\n📱 You'll receive a USSD prompt shortly — *approve it to complete the payment.*\n\nReference: ${receive.id}\n\nYour balance will update automatically once confirmed.`;
  } catch (err) {
    console.error('YellowCard submitReceive (topup) error:', err);
    const errMsg = err.data?.message || err.message || '';
    if (err.status === 504 || errMsg.includes('timed out')) {
      return `Yellow Card is taking too long to respond right now. Please wait a moment and reply 'menu' to try again.`;
    }
    if (errMsg.includes('No active channel')) {
      return `Sorry, *${ctx.channelType === 'bank' ? 'bank transfer' : 'mobile money'}* top-up is not available right now. Please try a different method or contact support.`;
    }
    if (errMsg.includes('networkId')) {
      return `Sorry, no payment network found for your country. Please contact support.`;
    }
    if (errMsg.includes('phone number') || errMsg.includes('InvalidPhoneNumber')) {
      return `The account number format wasn't accepted. Please try again with your full number including country code, e.g. +267XXXXXXXX.`;
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
    ? `\n\n_Still processing on Yellow Card. You'll receive a PDF receipt here once confirmed._`
    : '';
  return (
    `📋 *Transaction Status*\n\n` +
    `Type: ${typeLabel[t.type] || t.type}\n` +
    `Status: ${statusEmoji[t.status] || ''} *${t.status.charAt(0).toUpperCase() + t.status.slice(1)}*\n` +
    `Amount: ${parseFloat(t.amount).toFixed(2)} ${t.currency}\n` +
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
  const currency = msg.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return `Please choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
  await setSession(phone, 'invoice_create_amount', { ...session.context, currency });
  return 'How much is this invoice for? Enter just the number (e.g. 1500):';
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

module.exports = { handleIncomingMessage, MAIN_MENU, WELCOME };