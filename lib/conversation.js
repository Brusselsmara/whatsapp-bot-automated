const { supabase } = require('./db');
const yc = require('./yellowcard');

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
 * Main entry point. mediaUrls is an array of Twilio media URLs present on
 * this message (images/PDFs sent during KYC document upload), or [].
 */
async function handleIncomingMessage(phone, text, mediaUrls = []) {
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
  const balances = await getBalances(phone);
  await setSession(phone, 'idle', {});
  if (balances.length === 0) return 'Your balance is 0 across all currencies.';
  return balances.map((b) => `${b.currency}: ${b.balance}`).join('\n');
}

async function actionTransactionHistory(phone) {
  const history = await handleTransactionHistory(phone);
  await setSession(phone, 'idle', {});
  return history;
}

// ─── Business-only menu actions ────────────────────────────────────────────
async function actionPayInvoice(phone) {
  await setSession(phone, 'txn_recipient_name', { purpose: 'invoice_payment' });
  return "What's the supplier's name?";
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
  await setSession(phone, 'register_address', { ...session.context, dob: msg.trim() });
  return 'Home or business address? (street + city is fine)';
}

async function handleRegisterAddress(phone, msg, session) {
  await setSession(phone, 'register_id', { ...session.context, address: msg.trim() });
  return 'ID type and number? (e.g. "National ID 123456" or "Passport A1234567" — for a business, use a company registration number)';
}

async function handleRegisterId(phone, msg, session) {
  const parts = msg.trim().split(' ');
  const idNumber = parts.pop();
  const idType = parts.join(' ') || 'national_id';
  await setSession(phone, 'register_email', { ...session.context, idType, idNumber });
  return 'Email address?';
}

async function handleRegisterEmail(phone, msg, session) {
  const { getDocumentRequirementsMessage } = require('./email');
  const accountType = session.context.accountType || 'individual';

  await setSession(phone, 'register_documents', {
    ...session.context,
    email: msg.trim(),
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
  await setSession(phone, 'txn_recipient_account', { ...session.context, channelType });
  return channelType === 'bank' ? "Recipient's bank account number?" : "Recipient's mobile money number?";
}

async function handleTxnRecipientAccount(phone, msg, session) {
  await setSession(phone, 'txn_currency', { ...session.context, recipientAccountNumber: msg.trim() });
  return `Which currency? Reply with one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
}

async function handleTxnCurrency(phone, msg, session) {
  const currency = msg.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return `Please choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
  await setSession(phone, 'txn_amount', { ...session.context, currency });
  return 'How much would you like to send? Enter just the number.';
}

async function handleTxnAmount(phone, msg, session) {
  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }

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
    const networkId = networks[0]?.id;
    if (!networkId) {
      return `I couldn't find an active ${ctx.channelType} network for ${country} right now. Please try again shortly — your balance hasn't been touched.`;
    }

    await safeDebitWallet(phone, ctx.currency, ctx.amount);
    walletDebited = true;

    const sequenceId = `${ctx.purpose === 'invoice_payment' ? 'INV' : 'SEND'}-${Date.now()}`;
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
      amount: ctx.amount,
      currency: ctx.currency,
      status: send.status || 'pending',
      reference,
      recipient_name: ctx.recipientName,
      recipient_account_number: ctx.recipientAccountNumber,
      recipient_channel_type: ctx.channelType,
      yellowcard_reference: send.id,
      raw_response: send,
    });

    const label = ctx.purpose === 'invoice_payment' ? 'Invoice payment' : 'Transfer';
    return `✅ ${label} of ${ctx.amount} ${ctx.currency} to ${ctx.recipientName} initiated. Reference: ${send.id}\n\nI'll message you (with a PDF receipt) once it's confirmed.`;
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
  const channels = channelTypesFor(country);
  const ctx = { ...session.context, currency, country };

  if (channels.length > 1) {
    await setSession(phone, 'topup_channel_choice', ctx);
    return `Top up via:\n1️⃣ Bank transfer\n2️⃣ Mobile money`;
  }
  await setSession(phone, 'topup_amount', { ...ctx, channelType: channels[0] });
  return 'How much would you like to top up? Enter just the number.';
}

async function handleTopupChannelChoice(phone, msg, session) {
  const choice = msg.trim();
  const channelType = choice === '1' ? 'bank' : choice === '2' ? 'momo' : null;
  if (!channelType) return 'Please reply 1 for bank transfer or 2 for mobile money.';
  await setSession(phone, 'topup_amount', { ...session.context, channelType });
  return 'How much would you like to top up? Enter just the number.';
}

async function handleTopupAmount(phone, msg, session) {
  const amount = parseFloat(msg);
  if (isNaN(amount) || amount <= 0) {
    return "That doesn't look like a valid amount. Please enter a number, e.g. 500.";
  }
  await setSession(phone, 'topup_account_number', { ...session.context, amount });
  return session.context.channelType === 'momo'
    ? "What mobile money number will you pay from?\n\nYou'll receive a USSD prompt on that number to approve. (Sandbox: 1111111111 success, 0000000000 fail.)"
    : 'What bank account number will you pay from? (Sandbox: 1111111111 simulates success, 0000000000 simulates failure.)';
}

async function handleTopupAccountNumber(phone, msg, session) {
  await setSession(phone, 'idle', {});
  const ctx = session.context;
  const user = await getOrCreateUser(phone);

  const recipient = {
    name: user.kyc_name || user.business_name,
    country: ctx.country,
    phone,
    address: user.kyc_address,
    dob: user.kyc_dob,
    email: user.kyc_email,
    idNumber: user.kyc_id_number,
    idType: user.kyc_id_type,
  };
  const source = { accountType: ctx.channelType, accountNumber: msg.trim() };

  try {
    const networks = await yc.getNetworks(ctx.country, ctx.channelType);
    
    // ERROR: No networks available for this country/channel type
    if (!networks || networks.length === 0) {
      console.error(`[TOPUP ERROR] No active networks found for ${ctx.country}/${ctx.channelType}`);
      return `Sorry, we couldn't find active payment channels for ${ctx.channelType === 'momo' ? 'mobile money' : 'bank'} transfers in ${ctx.country}. ` +
             `Please try a different payment method or contact support.`;
    }
    
    // Set networkId from the first active network
    source.networkId = networks[0].id;
    console.log(`[TOPUP] Using network: ${networks[0].name || networks[0].id} for ${ctx.country}/${ctx.channelType}`);

    const receive = await yc.submitReceive({
      sequenceId: `TOPUP-${Date.now()}`,
      localAmount: ctx.amount,
      country: ctx.country,
      currency: ctx.currency,
      channelType: ctx.channelType,
      recipient,
      source,
    });

    await supabase.from('transactions').insert({
      type: 'topup',
      phone,
      amount: ctx.amount,
      currency: ctx.currency,
      status: receive.status || 'pending',
      recipient_channel_type: ctx.channelType,
      yellowcard_reference: receive.id,
      raw_response: receive,
    });

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
    
    // Provide specific error messages based on the error type
    if (err.data?.code === 'PaymentValidationError') {
      const msg = err.data?.message || 'Unknown validation error';
      console.error(`[TOPUP] Validation error: ${msg}`);
      
      if (msg.includes('networkId')) {
        return `We couldn't find payment networks for ${ctx.channelType === 'momo' ? 'mobile money' : 'bank'} in ${ctx.country}. Please check with support or try again later.`;
      }
      if (msg.includes('accountNumber')) {
        return `The account number you provided isn't valid for ${ctx.channelType === 'momo' ? 'mobile money' : 'bank'} transfers. Please try again.`;
      }
    }
    
    if (err.status === 400) {
      return "There was a problem with your request. Please check your details and try again.";
    }
    
    if (err.status === 401 || err.status === 403) {
      console.error('[TOPUP] Authentication error - check Yellow Card credentials in Vercel env vars');
      return "Service temporarily unavailable. Please try again shortly.";
    }
    
    return "I couldn't start the top-up right now. Please try again shortly, or reply 'menu'.";
  }
}

// ============================================================
// Status & history
// ============================================================

async function handleStatusLookup(phone, msg) {
  await setSession(phone, 'idle', {});
  const code = msg.trim();

  // Look up by yellowcard_reference (exact match only, parameterised)
  const { data: txnByRef } = await supabase
    .from('transactions')
    .select('*')
    .eq('yellowcard_reference', code)
    .eq('phone', phone)
    .maybeSingle();

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
  return (
    `📋 *Transaction Status*\n\n` +
    `Type: ${t.type.replace('_', ' ').toUpperCase()}\n` +
    `Status: *${t.status.toUpperCase()}*\n` +
    `Amount: ${t.amount} ${t.currency}\n` +
    (t.recipient_name ? `Recipient: ${t.recipient_name}\n` : '') +
    `Date: ${new Date(t.created_at).toLocaleDateString()}`
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

  return txns
    .map(
      (t) =>
        `${new Date(t.created_at).toLocaleDateString()} — ${t.type.toUpperCase()} — ${t.amount} ${t.currency} — ${t.status.toUpperCase()}`
    )
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
