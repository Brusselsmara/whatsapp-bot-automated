/**
 * Sends you (the business owner) an email whenever someone submits KYC/KYB
 * documents, with an Approve/Reject link you can click directly — no need
 * to reply with text, no fragile email-parsing required.
 *
 * Uses Resend (https://resend.com) — free tier covers this easily.
 * Get your API key from https://resend.com/api-keys → RESEND_API_KEY
 */
async function sendKycReviewEmail({ phone, accountType, businessName, attachments, approvalToken }) {
  const approveUrl = `${process.env.PUBLIC_APP_URL}/api/admin-kyc-decision?token=${approvalToken}&decision=approve`;
  const rejectUrl = `${process.env.PUBLIC_APP_URL}/api/admin-kyc-decision?token=${approvalToken}&decision=reject`;

  const html = `
    <h2>New KYC/KYB submission</h2>
    <p><strong>WhatsApp number:</strong> ${phone}</p>
    <p><strong>Account type:</strong> ${accountType}${businessName ? ` (${businessName})` : ''}</p>
    <p><strong>Documents:</strong> ${attachments.length} file(s) attached to this email.</p>
    <p>
      <a href="${approveUrl}" style="background:#16a34a;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:10px;">✅ Approve</a>
      <a href="${rejectUrl}" style="background:#dc2626;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">❌ Reject</a>
    </p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL, // e.g. 'PayLink <onboarding@resend.dev>' while testing
      to: process.env.ADMIN_EMAIL,
      subject: `New KYC submission — ${phone}`,
      html,
      attachments, // [{ filename, content: base64String }]
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Resend API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return res.json();
}

module.exports = { sendKycReviewEmail };
