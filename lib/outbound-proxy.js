/**
 * Static outbound IP proxy for serverless (Vercel) → Yellow Card production API.
 *
 * Set ONE of these in Vercel env (Fixie and QuotaGuard both use standard proxy URLs):
 *   FIXIE_URL=http://fixie:PASSWORD@velodrome.usefixie.com:80
 *   QUOTAGUARDSTATIC_URL=http://user:PASSWORD@us-east-static-XX.quotaguard.com:9293
 *   HTTPS_PROXY=...  (fallback)
 *
 * After deploy, GET /api/outbound-ip?secret=<CRON_SECRET> returns the IP to whitelist.
 */

const { fetch: undiciFetch, ProxyAgent } = require('undici');

let cachedAgent = null;
let cachedProxyUrl = null;

function getProxyUrl() {
  return (
    (process.env.FIXIE_URL || '').trim() ||
    (process.env.QUOTAGUARDSTATIC_URL || '').trim() ||
    (process.env.HTTPS_PROXY || '').trim() ||
    ''
  );
}

function isProxyConfigured() {
  return !!getProxyUrl();
}

function getProxyAgent() {
  const url = getProxyUrl();
  if (!url) return null;
  if (cachedAgent && cachedProxyUrl === url) return cachedAgent;
  cachedProxyUrl = url;
  cachedAgent = new ProxyAgent(url);
  return cachedAgent;
}

function getProxyProviderLabel() {
  if ((process.env.FIXIE_URL || '').trim()) return 'fixie';
  if ((process.env.QUOTAGUARDSTATIC_URL || '').trim()) return 'quotaguard';
  if ((process.env.HTTPS_PROXY || '').trim()) return 'https_proxy';
  return null;
}

/** Mask credentials for logs. */
function redactProxyUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    if (u.username) u.username = '****';
    return u.toString();
  } catch {
    return '[invalid proxy url]';
  }
}

/**
 * fetch() that routes through the static IP proxy when configured.
 * Uses undici ProxyAgent (required for Node native fetch on Vercel).
 */
async function proxiedFetch(url, options = {}) {
  const dispatcher = getProxyAgent();
  if (!dispatcher) {
    return fetch(url, options);
  }
  return undiciFetch(url, { ...options, dispatcher });
}

const IPIFY_URL = 'https://api.ipify.org?format=json';

/** Resolve the public egress IP (through proxy when configured). */
async function getOutboundIp({ timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await proxiedFetch(IPIFY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`IP lookup failed (${res.status})`);
    }
    const ip = data.ip;
    if (!ip || typeof ip !== 'string') {
      throw new Error('IP lookup returned no address');
    }
    return {
      ip: ip.trim(),
      proxyConfigured: isProxyConfigured(),
      provider: getProxyProviderLabel(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function assertProductionProxyIfRequired(isProductionYc) {
  if (!isProductionYc) return;
  if (process.env.YELLOWCARD_ALLOW_PRODUCTION !== 'true') return;
  if (isProxyConfigured()) return;
  throw new Error(
    'Production Yellow Card API requires a static outbound proxy on Vercel. ' +
    'Set FIXIE_URL or QUOTAGUARDSTATIC_URL in environment variables.'
  );
}

module.exports = {
  getProxyUrl,
  isProxyConfigured,
  getProxyProviderLabel,
  redactProxyUrl,
  proxiedFetch,
  getOutboundIp,
  assertProductionProxyIfRequired,
};
