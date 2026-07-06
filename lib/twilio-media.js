/**
 * Twilio media URLs (from incoming WhatsApp images/PDFs) require your
 * Account SID + Auth Token as Basic Auth to actually fetch the bytes.
 * This downloads a media URL and returns it as a base64 string + content
 * type, ready to attach to an email.
 */
async function downloadTwilioMedia(mediaUrl) {
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to download Twilio media (${res.status}): ${mediaUrl}`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('png') ? 'png' : 'jpg';

  return { base64, contentType, filename: `document-${Date.now()}.${ext}` };
}

module.exports = { downloadTwilioMedia };
