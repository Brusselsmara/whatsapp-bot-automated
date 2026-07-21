const {
  getOutboundIp,
  isProxyConfigured,
  getProxyProviderLabel,
  redactProxyUrl,
  getProxyUrl,
} = require('../lib/outbound-proxy');

/**
 * GET /api/outbound-ip?secret=<CRON_SECRET>
 *
 * Returns the public egress IP seen by external APIs (via Fixie/QuotaGuard when set).
 * Whitelist this IP on the Yellow Card production dashboard.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await getOutboundIp();
    const body = {
      ip: result.ip,
      proxyConfigured: result.proxyConfigured,
      provider: result.provider,
      proxyHost: result.proxyConfigured ? redactProxyUrl(getProxyUrl()) : null,
      note: result.proxyConfigured
        ? 'Whitelist this IP on the Yellow Card production dashboard.'
        : 'No FIXIE_URL / QUOTAGUARDSTATIC_URL set — this is Vercel’s dynamic IP, not safe to whitelist.',
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      return res.status(200).end();
    }
    return res.status(200).json(body);
  } catch (err) {
    console.error('[OUTBOUND-IP]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
