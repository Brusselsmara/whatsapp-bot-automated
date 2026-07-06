const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');

// This is the endpoint the Approve/Reject buttons in your KYC review email
// point to. It's a simple GET so clicking the button in email is enough —
// the long random token in the URL is what makes it safe (only someone with
// the exact link from your inbox can trigger a decision).

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
    return res.status(200).send(`This submission was already marked as "${submission.status}".`);
  }

  const newStatus = decision === 'approve' ? 'approved' : 'rejected';

  await supabase
    .from('kyc_submissions')
    .update({ status: newStatus, decided_at: new Date().toISOString() })
    .eq('id', submission.id);

  await supabase
    .from('users')
    .update({ kyc_status: newStatus })
    .eq('phone', submission.phone);

  // Make sure the user has wallet rows for all supported currencies once approved
  if (newStatus === 'approved') {
    const currencies = ['BWP', 'ZAR', 'ZMW'];
    for (const currency of currencies) {
      await supabase
        .from('wallets')
        .upsert({ phone: submission.phone, currency, balance: 0 }, { onConflict: 'phone,currency', ignoreDuplicates: true });
    }
  }

  const message =
    newStatus === 'approved'
      ? "✅ Good news — you're verified! Reply 'menu' to start using PayLink."
      : "Unfortunately we couldn't verify your documents this time. Please contact support, or reply 'menu' to try registering again.";

  try {
    await sendWhatsApp(submission.phone, message);
  } catch (err) {
    console.error('Failed to notify user of KYC decision:', err);
  }

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
    <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
      <h2>${newStatus === 'approved' ? '✅ Approved' : '❌ Rejected'}</h2>
      <p>${submission.phone} has been notified on WhatsApp.</p>
    </body></html>
  `);
};
