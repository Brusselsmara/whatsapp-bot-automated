/**
 * Handles "Request More Info" clicks from the KYC review email.
 * Shows a simple HTML form where the admin can optionally add a note,
 * then sends a WhatsApp message back to the applicant asking for
 * missing documents.
 */

const { supabase } = require('../lib/db');
const { sendWhatsApp } = require('../lib/twilio');
const { getMissingDocsMessage } = require('../lib/email');

module.exports = async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('Missing token.');
  }

  // ── GET: show the "add a note" form ────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: submission } = await supabase
      .from('kyc_submissions')
      .select('*, users(*)')
      .eq('approval_token', token)
      .single();

    if (!submission) {
      return res.status(404).send('This link is invalid or has already been used.');
    }

    if (submission.status !== 'pending') {
      return res.status(200).send(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
          <h2>Already actioned</h2>
          <p>This submission was already marked as <strong>${submission.status}</strong>.</p>
          <p>No further action taken.</p>
        </body></html>
      `);
    }

    const phone = submission.phone;
    const accountType = submission.users?.account_type || 'individual';
    const name = submission.users?.kyc_name || submission.users?.business_name || phone;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <html>
      <head>
        <title>Request More Info — PayLink KYC</title>
        <style>
          body { font-family: sans-serif; padding: 40px; max-width: 560px; margin: auto; color: #1e293b; }
          h2 { border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
          label { display: block; font-weight: bold; margin-top: 20px; margin-bottom: 6px; }
          textarea {
            width: 100%; height: 140px; padding: 10px; font-size: 14px;
            border: 1px solid #cbd5e1; border-radius: 6px; resize: vertical; box-sizing: border-box;
          }
          .hint { font-size: 12px; color: #94a3b8; margin-top: 4px; }
          button {
            margin-top: 20px; background: #d97706; color: white; border: none;
            padding: 12px 28px; font-size: 15px; border-radius: 6px;
            cursor: pointer; font-weight: bold;
          }
          button:hover { background: #b45309; }
          .applicant { background: #f8fafc; padding: 12px 16px; border-radius: 6px;
                       border: 1px solid #e2e8f0; margin-bottom: 20px; font-size: 14px; }
        </style>
      </head>
      <body>
        <h2>📋 Request More Info</h2>

        <div class="applicant">
          <strong>Applicant:</strong> ${name}<br>
          <strong>WhatsApp:</strong> ${phone}<br>
          <strong>Type:</strong> ${accountType}
        </div>

        <p>
          A WhatsApp message will be sent to <strong>${phone}</strong> listing all required
          documents and your note below. The submission will remain in <em>pending</em> state
          so you can review again once they re-submit.
        </p>

        <form method="POST" action="/api/admin-kyc-request-info?token=${token}">
          <label for="note">
            Optional note to applicant
            <span style="font-weight:normal;color:#64748b">(e.g. which specific document is missing or unclear)</span>:
          </label>
          <textarea id="note" name="note" placeholder="e.g. Your proof of address is older than 3 months — please send a more recent one."></textarea>
          <p class="hint">Leave blank to send only the standard document checklist.</p>

          <button type="submit">📤 Send Request via WhatsApp</button>
        </form>
      </body>
      </html>
    `);
  }

  // ── POST: process the form, send WhatsApp message ──────────────────────────
  if (req.method === 'POST') {
    const { data: submission } = await supabase
      .from('kyc_submissions')
      .select('*, users(*)')
      .eq('approval_token', token)
      .single();

    if (!submission) {
      return res.status(404).send('Submission not found.');
    }

    if (submission.status !== 'pending') {
      return res.status(200).send(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
          <h2>Already actioned</h2>
          <p>This submission was already marked as <strong>${submission.status}</strong>.</p>
        </body></html>
      `);
    }

    const note        = (req.body?.note || '').trim();
    const phone       = submission.phone;
    const accountType = submission.users?.account_type || 'individual';
    const name        = submission.users?.kyc_name || submission.users?.business_name || phone;

    // Mark submission as 'more_info_requested' so admin knows it's been actioned,
    // and persist the note so there's a record of what was asked for even after
    // a new kyc_submissions row is created on resubmission.
    await supabase
      .from('kyc_submissions')
      .update({
        status:     'more_info_requested',
        decided_at: new Date().toISOString(),
        note:       note || null,
      })
      .eq('id', submission.id);

    // Reset user's KYC state to allow re-submission of documents
    await supabase
      .from('users')
      .update({ kyc_status: 'pending_review' })
      .eq('phone', phone);

    // Re-open the conversation session so the user can send docs again
    await supabase
      .from('sessions')
      .upsert({
        phone,
        state:      'register_documents',
        context:    {
          accountType,
          name:        submission.users?.kyc_name,
          businessName: submission.users?.business_name,
          dob:         submission.users?.kyc_dob,
          address:     submission.users?.kyc_address,
          idType:      submission.users?.kyc_id_type,
          idNumber:    submission.users?.kyc_id_number,
          email:       submission.users?.kyc_email,
          documentUrls: [],
          resubmission: true,
          previousNote: note || null,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'phone' });

    // Send WhatsApp message to the user
    const message = getMissingDocsMessage(accountType, note);

    try {
      await sendWhatsApp(phone, message);
    } catch (err) {
      console.error('Failed to send WhatsApp more-info message:', err);
      return res.status(500).send(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
          <h2 style="color:#dc2626">⚠️ WhatsApp send failed</h2>
          <p>The database was updated but the WhatsApp message to <strong>${phone}</strong> 
          could not be sent. Error: ${err.message}</p>
          <p>Please message them manually.</p>
        </body></html>
      `);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <html>
      <body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
        <h2 style="color:#d97706">📋 More Info Requested</h2>
        <p><strong>${name}</strong> (${phone}) has been messaged on WhatsApp.</p>
        <p>Their submission remains under review — once they re-send documents, 
        a new KYC email will arrive for you to action.</p>
        ${note ? `<p><strong>Your note sent:</strong><br><em>${note}</em></p>` : ''}
      </body>
      </html>
    `);
  }

  return res.status(405).send('Method not allowed');
};