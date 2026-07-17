/**
 * Normalise PUBLIC_APP_URL to the deployment root (no trailing slash).
 * Strips a common misconfiguration where the WhatsApp webhook path
 * (/api/whatsapp) was pasted instead of the bare Vercel domain.
 */
function collapseUrlSlashes(url) {
  return url.replace(/([^:]\/)\/+/g, '$1');
}

function getPublicAppUrl() {
  let url = (process.env.PUBLIC_APP_URL || '').trim();
  url = url.replace(/\/api\/whatsapp\/?$/i, '');
  url = url.replace(/\/+$/, '');
  return collapseUrlSlashes(url);
}

/** Join a path onto PUBLIC_APP_URL without accidental double slashes. */
function publicAppUrl(path = '') {
  const base = getPublicAppUrl();
  if (!path) return base;
  const segment = path.startsWith('/') ? path : `/${path}`;
  return collapseUrlSlashes(`${base}${segment}`);
}

module.exports = { getPublicAppUrl, publicAppUrl };
