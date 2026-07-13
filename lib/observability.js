/**
 * Optional Sentry integration — active only when SENTRY_DSN is set.
 * Falls back to structured console logging so local dev works without Sentry.
 */

let sentry = null;
let initialized = false;

function initObservability() {
  if (initialized) return;
  initialized = true;

  const dsn = (process.env.SENTRY_DSN || '').trim();
  if (!dsn) return;

  try {
    // eslint-disable-next-line global-require
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,
    });
    sentry = Sentry;
  } catch (err) {
    console.warn('[OBS] Sentry init failed:', err.message);
  }
}

/**
 * @param {Error|string} error
 * @param {Record<string, unknown>} [context]
 */
function captureError(error, context = {}) {
  initObservability();
  const err = error instanceof Error ? error : new Error(String(error));

  console.error('[OBS]', err.message, context);

  if (sentry) {
    sentry.withScope((scope) => {
      Object.entries(context).forEach(([key, value]) => {
        scope.setExtra(key, value);
      });
      sentry.captureException(err);
    });
  }
}

module.exports = { initObservability, captureError };
