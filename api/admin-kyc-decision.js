const { supabase } = require('../lib/db');
const { notifyUser } = require('../lib/notifications');
const yc = require('../lib/yellowcard');
const { buildFeeScheduleUrl, formatKycApprovalNotificationBody } = require('../lib/fee-schedule');
const { getPublicAppUrl } = require('../lib/app-url');

module.exports = async (req, res) => {
  const { token, decision } = req.query;

  if (!token || !['approve', 'reject'].includes(decision)) {
    return res.status(400).send('Invalid request.');
  }

  const { data: submission } = await supabase
    .from('kyc_submissions')
    .select('*')
    .eq('approval_token', token)
    .single();

  if (!submission) {
    return res.status(404).send('This link is invalid or has already been used.');
  }

  if (submission.status !== 'pending') {
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
        <h2>Already actioned</h2>
        <p>This submission was already marked as <strong>"${submission.status}"</strong>.</p>
        <p>No further action taken.</p>
      </body></html>
    `);
  }

  const newStatus = decision === 'approve' ? 'approved' : 'rejected';

  await supabase
    .from('kyc_submissions')
    .update({ status: newStatus, decided_at: new Date().toISOString() })
    .eq('id', submission.id);

  const detected = yc.detectCountryFromNumber(submission.phone);
  await supabase
    .from('users')
    .update({
      kyc_status: newStatus,
      ...(detected && newStatus === 'approved'
        ? { home_currency: detected.currency, home_country: detected.country }
        : {}),
    })
    .eq('phone', submission.phone);

  if (newStatus === 'approved') {
    let homeCurrency = detected?.currency;
    if (!homeCurrency) {
      const { data: user } = await supabase
        .from('users')
        .select('home_currency')
        .eq('phone', submission.phone)
        .maybeSingle();
      homeCurrency = user?.home_currency;
    }
    if (homeCurrency) {
      await supabase.from('wallets').upsert(
        { phone: submission.phone, currency: homeCurrency, balance: 0 },
        { onConflict: 'phone,currency', ignoreDuplicates: true }
      );
      await supabase.from('wallets').delete()
        .eq('phone', submission.phone)
        .neq('currency', homeCurrency)
        .eq('balance', 0);
    } else {
      console.warn(`[KYC] No home currency for ${submission.phone} — wallet will be created on first use`);
    }
  }

  try {
    if (newStatus === 'approved') {
      const homeCurrency = detected?.currency;
      const body = formatKycApprovalNotificationBody({ walletCurrency: homeCurrency });
      const actionUrl = getPublicAppUrl() ? buildFeeScheduleUrl() : null;

      await notifyUser(submission.phone, {
        type: 'kyc_approved',
        title: 'Account verified',
        body: actionUrl
          ? body
          : `${body}\n\n(Fee schedule PDF unavailable — set PUBLIC_APP_URL on your deployment.)`,
        actionUrl,
      });
    } else {
      await notifyUser(submission.phone, {
        type: 'kyc_rejected',
        title: 'Verification not approved',
        body:
          'Unfortunately we could not verify your account. Your submitted documents did not meet our requirements. ' +
          'Open the PayLink app and reply menu to start a new registration, or contact support if you believe this is an error.',
        actionUrl: getPublicAppUrl() ? `${getPublicAppUrl()}/` : null,
      });
    }
  } catch (err) {
    console.error('Failed to notify user of KYC decision:', err);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
        <h2 style="color:#dc2626">⚠️ Notification failed</h2>
        <p>The account was updated to <strong>${newStatus}</strong>, but the PayLink app notification for
        <strong>${submission.phone}</strong> could not be sent.</p>
        <p><strong>Error:</strong> ${err.message}</p>
        <p>Ensure <code>005_user_notifications.sql</code> has been run in Supabase, then try again or ask the customer to open the app after you re-send from admin.</p>
      </body></html>
    `);
  }

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
    <html>
    <body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto;text-align:center">
      <h2 style="color:${newStatus === 'approved' ? '#16a34a' : '#dc2626'}">
        ${newStatus === 'approved' ? '✅ Approved' : '❌ Rejected'}
      </h2>
      <p><strong>${submission.phone}</strong> has been notified in the PayLink app.</p>
      ${newStatus === 'approved'
        ? `<p>Their ${detected ? detected.currency + ' home-currency' : ''} wallet has been created.</p>`
        : ''}
    </body>
    </html>
  `);
};
