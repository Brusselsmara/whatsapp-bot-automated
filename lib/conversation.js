const { supabase } = require('./db');
const yc = require('./yellowcard');
const { sendKycReviewEmail } = require('./email');
const { downloadTwilioMedia } = require('./twilio-media');

const WELCOME = `Welcome to *PayLink* 👋
Cross-border money transfer & invoice settlement.

1️⃣ Register
2️⃣ Help`;

const MAIN_MENU = `What would you like to do?

1️⃣ Pay Invoice
2️⃣ Send money to bank or mobile wallet
3️⃣ Top-up Balance
4️⃣ Check Balance
5️⃣ Check invoice paid status
6️⃣ Transaction History`;

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

    default:
      await setSession(phone, 'idle', {});
      return routeHome(phone, user);
  }
}

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

  // approved — dispatch main menu number choices
  if (msg) {
    switch (msg.trim()) {
      case '1':
        await setSession(phone, 'txn_recipient_name', { purpose: 'invoice_payment' });
        return "What's the supplier's name?";
      case '2':
        await setSession(phone, 'txn_recipient_name', { purpose: 'send' });
        return "What's the recipient's name?";
      case '3':
        await setSession(phone, 'topup_currency', {});
        return `Which currency? Reply with one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
      case '4': {
        const balances = await getBalances(phone);
        await setSession(phone, 'idle', {});
        if (balances.length === 0) return 'Your balance is 0 across all currencies.';
        return balances.map((b) => `${b.currency}: ${b.balance}`).join('\n');
      }
      case '5':
        await setSession(phone, 'status_lookup', {});
        return 'Enter the transaction reference or invoice code to check.';
      case '6': {
        const history = await handleTransactionHistory(phone);
        await setSession(phone, 'idle', {});
        return history;
      }
    }
  }

  await setSession(phone, 'idle', {});
  return MAIN_MENU;
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
  await setSession(phone, 'register_documents', { ...session.context, email: msg.trim(), documentUrls: [] });
  return `Almost done — please send photos or PDFs of your verification documents now (ID, proof of address, and business registration docs if applicable).

Send them one at a time. When you've sent everything, reply *"done"*.`;
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
      account_type: ctx.accountType,
      business_name: ctx.businessName || null,
      kyc_status: 'pending_review',
      kyc_name: ctx.name,
      kyc_dob: ctx.dob,
      kyc_address: ctx.address,
      kyc_id_type: ctx.idType,
      kyc_id_number: ctx.idNumber,
      kyc_email: ctx.email,
    })
    .eq('phone', phone);

  const { data: submission } = await supabase
    .from('kyc_submissions')
    .insert({ phone, document_urls: documentUrls })
    .select()
    .single();

  try {
    const attachments = [];
    for (const url of documentUrls) {
      try {
        const { base64, filename } = await downloadTwilioMedia(url);
        attachments.push({ filename, content: base64 });
      } catch (e) {
        console.error('Failed to download a document, skipping attachment:', e);
      }
    }

    await sendKycReviewEmail({
      phone,
      accountType: ctx.accountType,
      businessName: ctx.businessName,
      attachments,
      approvalToken: submission.approval_token,
    });
  } catch (err) {
    console.error('Failed to send KYC review email:', err);
  }

  return "Thanks! Your documents have been submitted for review. We'll message you here once you're verified — usually within 1 business day.";
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

async function finalizeTransaction(phone, ctx, reference) {
  await setSession(phone, 'idle', {});
  const user = await getOrCreateUser(phone);
  const country = CURRENCY_TO_COUNTRY[ctx.currency];

  try {
    const networks = await yc.getNetworks(country, ctx.channelType);
    const networkId = networks[0]?.id;
    if (!networkId) {
      return `I couldn't find an active ${ctx.channelType} network for ${country} right now. Please try again shortly — your balance hasn't been touched.`;
    }

    // Debit the wallet up front; refund if the send later fails (handled in the webhook).
    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('phone', phone)
      .eq('currency', ctx.currency)
      .single();
    await supabase
      .from('wallets')
      .update({ balance: parseFloat(wallet.balance) - ctx.amount, updated_at: new Date().toISOString() })
      .eq('phone', phone)
      .eq('currency', ctx.currency);

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
    console.error('YellowCard submitSend error:', err);
    return "I couldn't start that transaction right now. Please try again shortly — your balance hasn't been touched if this failed before debiting.";
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
    ? 'What mobile money number will you pay from? (Sandbox: 1111111111 simulates success, 0000000000 simulates failure.)'
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
    if (networks[0]) source.networkId = networks[0].id;

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

Your balance will update automatically once confirmed.`;
    }

    return `✅ Top-up of ${ctx.amount} ${ctx.currency} initiated via mobile money. Reference: ${receive.id}\n\nYour balance will update automatically once confirmed.`;
  } catch (err) {
    console.error('YellowCard submitReceive (topup) error:', err);
    return "I couldn't start the top-up right now. Please try again shortly, or reply 'menu'.";
  }
}

// ============================================================
// Status & history
// ============================================================

async function handleStatusLookup(phone, msg) {
  await setSession(phone, 'idle', {});
  const code = msg.trim();

  const { data: txn } = await supabase
    .from('transactions')
    .select('*')
    .or(`yellowcard_reference.eq.${code},reference.eq.${code}`)
    .eq('phone', phone)
    .single();

  if (txn) {
    return `${txn.type.toUpperCase()} — ${txn.status.toUpperCase()} — ${txn.amount} ${txn.currency}${txn.recipient_name ? ` to ${txn.recipient_name}` : ''}`;
  }

  const { data: invoice } = await supabase.from('invoices').select('*').eq('invoice_code', code.toUpperCase()).single();
  if (invoice) {
    return `Invoice ${code}: ${invoice.status.toUpperCase()} — ${invoice.amount} ${invoice.currency}`;
  }

  return "I couldn't find anything with that reference. Double check it, or reply 'menu'.";
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

module.exports = { handleIncomingMessage, MAIN_MENU, WELCOME };
