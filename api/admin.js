const {
  isAdminAuthConfigured,
  isAdminAuthenticated,
  verifyLoginPassword,
  createSessionCookie,
  clearSessionCookie,
} = require('../lib/admin-auth');
const { fetchAdminDashboardData } = require('../lib/admin-metrics');
const { parseDateFilters } = require('../lib/admin-filters');
const { buildTransactionsCsv, csvFilename } = require('../lib/admin-csv');
const { renderLoginPage, renderDashboardPage } = require('../lib/admin-dashboard');

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

module.exports = async (req, res) => {
  const configured = isAdminAuthConfigured();

  if (req.method === 'POST') {
    const body = parseBody(req);
    const action = body.action || req.query.action;

    if (action === 'logout') {
      res.setHeader('Set-Cookie', clearSessionCookie());
      return res.status(302).setHeader('Location', '/api/admin').end();
    }

    if (action === 'login') {
      if (!configured) {
        return res.status(503).send(renderLoginPage({ configured: false }));
      }
      if (!verifyLoginPassword(body.password)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(401).send(renderLoginPage({ error: 'Incorrect password.', configured: true }));
      }
      res.setHeader('Set-Cookie', createSessionCookie());
      return res.status(302).setHeader('Location', '/api/admin').end();
    }

    return res.status(400).send('Unknown action');
  }

  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  if (!configured) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(503).send(renderLoginPage({ configured: false }));
  }

  if (!isAdminAuthenticated(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(renderLoginPage({ configured: true }));
  }

  const parsedFilters = parseDateFilters(req.query);
  if (parsedFilters.error) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const empty = {
      byCurrency: {},
      transactions: [],
      exportTransactions: [],
      totals: { registeredUsers: 0, completedTransactions: 0, filteredTransactions: 0 },
      filters: { fromLabel: req.query.from || null, toLabel: req.query.to || null },
      generatedAt: new Date().toISOString(),
    };
    return res.status(400).send(renderDashboardPage(empty, { filterError: parsedFilters.error }));
  }

  try {
    const data = await fetchAdminDashboardData(parsedFilters);

    if (req.query.format === 'csv') {
      const csv = buildTransactionsCsv(data.exportTransactions);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(data.filters)}"`);
      return res.status(200).send(csv);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(renderDashboardPage(data));
  } catch (err) {
    console.error('[ADMIN] dashboard error:', err);
    return res.status(500).send(`Admin dashboard error: ${err.message}`);
  }
};
