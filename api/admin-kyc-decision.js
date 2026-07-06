const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');

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

  // Update user KYC status
  await supabase
    .from('users')
    .update({ kyc_status: newStatus })
    .eq('phone', submission.phone);

  // Create wallets for all supported currencies on approval
  if (newStatus === 'approved') {
    const currencies = ['BWP', 'ZAR', 'ZMW'];
    for (const currency of currencies) {
      await supabase
        .from('wallets')
        .upsert(
          { phone: submission.phone, currency, balance: 0 },
          { onConflict: 'phone,currency', ignoreDuplicates: true }
        );
    }
  }

  // Notify user via WhatsApp
  const message =
    newStatus === 'approved'
      ? `✅ *Great news — you're verified!*\n\nWelcome to *PayLink*! Your account is now active.\n\nReply *"menu"* to see what you can do.`
      : `❌ *Unfortunately we couldn't verify your account.*\n\nYour submitted documents did not meet our verification requirements.\n\nIf you believe this is an error, please contact support or reply *"menu"* to start a new registration.`;

  try {
    await sendWhatsApp(submission.phone, message);
  } catch (err) {
    console.error('Failed to notify user of KYC decision:', err);
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
        ? '<p>Their wallet has been created for BWP, ZAR, and ZMW.</p>'
        : ''}
    </body>
    </html>
  `);
};