/**
 * Sends KYC/KYB review email to admin with Approve / Request More Info / Reject buttons.
 * Documents required are listed clearly in both the email and the in-app registration prompt.
 */

const { publicAppUrl } = require('./app-url');

// ─── Document requirements ────────────────────────────────────────────────────

const KYC_DOCS_INDIVIDUAL = [
  'Government-issued photo ID (National ID, Passport, or Driver\'s Licence)',
  'Proof of address (utility bill, bank statement — dated within 3 months)',
  'Selfie holding the ID document (for liveness check)',
];

const KYC_DOCS_BUSINESS = [
  'Certificate of Incorporation / Business Registration Certificate',
  'Company tax registration certificate',
  'Proof of business address (utility bill or bank statement — dated within 3 months)',
  'Government-issued photo ID of the authorised representative',
  'Proof of address of the authorised representative (dated within 3 months)',
  'Selfie of the authorised representative holding their ID',
  'Latest audited financial statements or management accounts (if available)',
];

/**
 * Returns the registration chat message telling a new user which documents to upload.
 * Used in conversation.js during registration.
 */
function getDocumentRequirementsMessage(accountType) {
  const docs = accountType === 'business' ? KYC_DOCS_BUSINESS : KYC_DOCS_INDIVIDUAL;
  const list = docs.map((d, i) => `${i + 1}. ${d}`).join('\n');

  return (
    `📋 *Documents required for ${accountType === 'business' ? 'Business (KYB)' : 'Individual (KYC)'} verification:*\n\n` +
    `${list}\n\n` +
    `Please send each document as a clear photo or PDF, one at a time.\n` +
    `When you've sent everything, reply *"done"*.\n\n` +
    `We'll notify you in the *Romela Pula app* when your review is complete.`
  );
}

/**
 * Short notification body when admin requests more KYC/KYB documents.
 */
function getMissingDocsNotificationBody(accountType, missingNote) {
  const label = accountType === 'business' ? 'business (KYB)' : 'individual (KYC)';
  let body =
    `We need additional documents for your ${label} verification. ` +
    `Open the Romela Pula app, tap the bell icon for details, upload the missing items, then reply done in the app.`;
  if (missingNote) body += `\n\nNote from our team: ${missingNote}`;
  return body;
}

/**
 * Returns a WhatsApp message requesting specific missing documents.
 * Sent when admin clicks "Request More Info".
 */
function getMissingDocsMessage(accountType, missingNote) {
  const docs = accountType === 'business' ? KYC_DOCS_BUSINESS : KYC_DOCS_INDIVIDUAL;
  const list = docs.map((d, i) => `${i + 1}. ${d}`).join('\n');

  return (
    `⚠️ *Additional documents needed*\n\n` +
    `We've reviewed your registration but need more information before we can verify your account.\n\n` +
    (missingNote
      ? `*Specific note from our team:*\n${missingNote}\n\n`
      : '') +
    `*Full document checklist for ${accountType === 'business' ? 'business' : 'individual'} verification:*\n\n` +
    `${list}\n\n` +
    `Please send the missing documents as clear photos or PDFs, one at a time.\n` +
    `Reply *"done"* when finished — your submission will be re-reviewed within 1 business day.`
  );
}

// ─── Resend email sender ──────────────────────────────────────────────────────

async function sendKycReviewEmail({
  phone,
  accountType,
  businessName,
  kycName,
  kycDob,
  kycAddress,
  kycIdType,
  kycIdNumber,
  kycEmail,
  attachments,
  approvalToken,
  previousNote,
}) {
  const approveUrl     = publicAppUrl(`/api/admin-kyc-decision?token=${approvalToken}&decision=approve`);
  const rejectUrl      = publicAppUrl(`/api/admin-kyc-decision?token=${approvalToken}&decision=reject`);
  const requestInfoUrl = publicAppUrl(`/api/admin-kyc-request-info?token=${approvalToken}`);

  const docs = accountType === 'business' ? KYC_DOCS_BUSINESS : KYC_DOCS_INDIVIDUAL;
  const docChecklist = docs
    .map((d) => `<li style="margin-bottom:4px">${d}</li>`)
    .join('');

  const attachmentNote = attachments.length
    ? `<p><strong>📎 Attached documents:</strong> ${attachments.length} file(s) attached to this email.</p>`
    : `<p style="color:#dc2626"><strong>⚠️ No documents attached</strong> — the user may not have uploaded any.</p>`;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">

      <h2 style="color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
        🪪 New ${accountType === 'business' ? 'Business (KYB)' : 'Individual (KYC)'} Submission
      </h2>

      <h3 style="color:#475569">Applicant Details</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="background:#f8fafc">
          <td style="padding:8px 12px;font-weight:bold;width:40%">WhatsApp Number</td>
          <td style="padding:8px 12px">${phone}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:bold">Account Type</td>
          <td style="padding:8px 12px">${accountType}${businessName ? ` — ${businessName}` : ''}</td>
        </tr>
        <tr style="background:#f8fafc">
          <td style="padding:8px 12px;font-weight:bold">Full Name</td>
          <td style="padding:8px 12px">${kycName || '—'}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:bold">Date of Birth</td>
          <td style="padding:8px 12px">${kycDob || '—'}</td>
        </tr>
        <tr style="background:#f8fafc">
          <td style="padding:8px 12px;font-weight:bold">Address</td>
          <td style="padding:8px 12px">${kycAddress || '—'}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:bold">ID Type</td>
          <td style="padding:8px 12px">${kycIdType || '—'}</td>
        </tr>
        <tr style="background:#f8fafc">
          <td style="padding:8px 12px;font-weight:bold">ID Number</td>
          <td style="padding:8px 12px">${kycIdNumber || '—'}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:bold">Email</td>
          <td style="padding:8px 12px">${kycEmail || '—'}</td>
        </tr>
      </table>

      ${previousNote ? `
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 16px;margin-top:20px">
        <strong style="color:#92400e">📋 This is a resubmission — you previously asked for:</strong>
        <p style="margin:6px 0 0;color:#78350f">${previousNote}</p>
      </div>
      ` : ''}

      <h3 style="color:#475569;margin-top:24px">
        📋 Required Documents Checklist
        <span style="font-size:12px;color:#94a3b8;font-weight:normal">
          (verify each is present in the attachments)
        </span>
      </h3>
      <ul style="font-size:14px;color:#334155;line-height:1.8">
        ${docChecklist}
      </ul>

      ${attachmentNote}

      <h3 style="color:#475569;margin-top:24px">Actions</h3>
      <div style="margin-top:16px">

        <a href="${approveUrl}"
           style="display:inline-block;background:#16a34a;color:#fff;
                  padding:12px 24px;text-decoration:none;border-radius:6px;
                  font-weight:bold;margin-right:8px;margin-bottom:8px">
          ✅ Approve
        </a>

        <a href="${requestInfoUrl}"
           style="display:inline-block;background:#d97706;color:#fff;
                  padding:12px 24px;text-decoration:none;border-radius:6px;
                  font-weight:bold;margin-right:8px;margin-bottom:8px">
          📋 Request More Info
        </a>

        <a href="${rejectUrl}"
           style="display:inline-block;background:#dc2626;color:#fff;
                  padding:12px 24px;text-decoration:none;border-radius:6px;
                  font-weight:bold;margin-bottom:8px">
          ❌ Reject
        </a>

      </div>

      <p style="margin-top:16px;font-size:12px;color:#94a3b8">
        These links act immediately — no login required. The token in the URL is 
        unique to this submission and expires once a decision is made.
      </p>

    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:        process.env.RESEND_FROM_EMAIL,
      to:          process.env.ADMIN_EMAIL,
      subject:     `[KYC Review] ${kycName || businessName || phone} — ${accountType}`,
      html,
      attachments,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Resend API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return res.json();
}

module.exports = {
  sendKycReviewEmail,
  getDocumentRequirementsMessage,
  getMissingDocsMessage,
  getMissingDocsNotificationBody,
  KYC_DOCS_INDIVIDUAL,
  KYC_DOCS_BUSINESS,
};