const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const yc = require('../lib/yellowcard');
const { buildFeeScheduleUrl, formatKycApprovalMessage } = require('../lib/fee-schedule');
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

  // Update KYC submission
  await supabase
    .from('kyc_submissions')
    .update({ status: newStatus, decided_at: new Date().toISOString() })
    .eq('id', submission.id);

  // Update user KYC status (+ home currency from WhatsApp dial code when possible)
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

  // Create only the user's single home-currency wallet on approval
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
      console.warn(`[KYC] No home currency for ${submission.phone} — wallet will be created on first bot use`);
    }
  }

  // Notify user via WhatsApp
  if (newStatus === 'approved') {
    const homeCurrency = detected?.currency;
    const message = formatKycApprovalMessage({ walletCurrency: homeCurrency });
    const feeScheduleUrl = getPublicAppUrl() ? buildFeeScheduleUrl() : null;

    try {
      if (feeScheduleUrl) {
        await sendWhatsApp(submission.phone, message, feeScheduleUrl);
      } else {
        console.warn(`[KYC] PUBLIC_APP_URL not set — fee schedule PDF skipped for ${submission.phone}`);
        await sendWhatsApp(
          submission.phone,
          `${message}\n\n_(Fee schedule PDF unavailable — set PUBLIC_APP_URL on your deployment.)_`
        );
      }
    } catch (err) {
      console.error('Failed to notify user of KYC approval:', err);
    }
  } else {
    const message =
      `❌ *Unfortunately we couldn't verify your account.*\n\n` +
      `Your submitted documents did not meet our verification requirements.\n\n` +
      `If you believe this is an error, please contact support or reply *"menu"* to start a new registration.`;
    try {
      await sendWhatsApp(submission.phone, message);
    } catch (err) {
      console.error('Failed to notify user of KYC rejection:', err);
    }
  }

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
    <html>
    <body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto;text-align:center">
      <h2 style="color:${newStatus === 'approved' ? '#16a34a' : '#dc2626'}">
        ${newStatus === 'approved' ? '✅ Approved' : '❌ Rejected'}
      </h2>
      <p><strong>${submission.phone}</strong> has been notified on WhatsApp.</p>
      ${newStatus === 'approved'
        ? `<p>Their ${detected ? detected.currency + ' home-currency' : ''} wallet has been created.</p>`
        : ''}
    </body>
    </html>
  `);
};