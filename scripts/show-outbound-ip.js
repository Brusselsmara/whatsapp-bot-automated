/**
 * Print the public egress IP used for Yellow Card API calls (via proxy when configured).
 *
 * Usage:
 *   node -r dotenv/config scripts/show-outbound-ip.js dotenv_config_path=.env.local
 */
const { getOutboundIp, isProxyConfigured, redactProxyUrl, getProxyUrl } = require('../lib/outbound-proxy');

async function main() {
  if (!isProxyConfigured()) {
    console.warn('⚠️  No FIXIE_URL / QUOTAGUARDSTATIC_URL set — showing Vercel/local dynamic IP (not for YC whitelist).');
  } else {
    console.log(`Proxy: ${redactProxyUrl(getProxyUrl())}`);
  }

  const result = await getOutboundIp();
  console.log('\nOutbound IP (whitelist this on Yellow Card production):');
  console.log(`  ${result.ip}`);
  console.log(`  provider: ${result.provider || 'none (direct)'}`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
