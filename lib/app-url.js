/**
 * Normalise PUBLIC_APP_URL to the deployment root (no trailing slash).
 * Strips a common misconfiguration where the Twilio webhook path
 * (/api/whatsapp) was pasted instead of the bare Vercel domain.
 */
function getPublicAppUrl() {
  let url = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  url = url.replace(/\/api\/whatsapp$/i, '');
  return url;
}

module.exports = { getPublicAppUrl };
