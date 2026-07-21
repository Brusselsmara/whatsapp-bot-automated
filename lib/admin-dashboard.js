const { formatMoney } = require('./admin-metrics');
const { filtersQueryString } = require('./admin-filters');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLoginPage({ error, configured }) {
  if (!configured) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Romela Pula Admin</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f8;margin:0;padding:40px 16px;color:#1a1a2e}
  .card{max-width:420px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-size:1.4rem;margin:0 0 8px}
  p{color:#555;line-height:1.5}
  code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:.85rem}
</style></head><body>
<div class="card">
  <h1>Romela Pula Admin</h1>
  <p>Admin access is not configured. Set <code>ADMIN_SECRET</code> in your Vercel environment variables, then redeploy.</p>
</div></body></html>`;
  }

  const errBlock = error ? `<p class="err">${esc(error)}</p>` : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Romela Pula Admin — Sign in</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f8;margin:0;padding:40px 16px;color:#1a1a2e}
  .card{max-width:420px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-size:1.4rem;margin:0 0 4px}
  .sub{color:#666;font-size:.9rem;margin:0 0 24px}
  label{display:block;font-size:.85rem;font-weight:600;margin-bottom:6px}
  input[type=password]{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font-size:1rem;box-sizing:border-box}
  button{margin-top:16px;width:100%;padding:12px;background:#1a56db;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#1446b0}
  .err{color:#b42318;background:#fef3f2;border:1px solid #fecdca;padding:10px 12px;border-radius:8px;font-size:.9rem;margin-bottom:16px}
</style></head><body>
<div class="card">
  <h1>Romela Pula Admin</h1>
  <p class="sub">For operators only — not visible to WhatsApp customers.</p>
  ${errBlock}
  <form method="POST" action="/api/admin">
    <input type="hidden" name="action" value="login">
    <label for="password">Admin password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Sign in</button>
  </form>
</div></body></html>`;
}

function renderFilterBar(data) {
  const from = data.filters?.fromLabel || '';
  const to = data.filters?.toLabel || '';
  const qs = filtersQueryString(data.filters || {});
  const csvQs = qs ? `${qs}&format=csv` : '?format=csv';
  const filterNote = from || to
    ? `<span class="filter-note">Showing ${data.totals.filteredTransactions} completed transaction(s)${from ? ` from ${esc(from)}` : ''}${to ? ` to ${esc(to)}` : ''}</span>`
    : '<span class="filter-note">Showing all dates</span>';

  return `
  <section class="filters">
    <form method="GET" action="/api/admin" class="filter-form">
      <div class="field">
        <label for="from">From</label>
        <input type="date" id="from" name="from" value="${esc(from)}">
      </div>
      <div class="field">
        <label for="to">To</label>
        <input type="date" id="to" name="to" value="${esc(to)}">
      </div>
      <button type="submit" class="btn-primary">Apply</button>
      <a href="/api/admin" class="btn-secondary">Clear</a>
      <a href="/api/admin${esc(csvQs)}" class="btn-export">Export CSV</a>
    </form>
    ${filterNote}
  </section>`;
}

function renderFilterError(message) {
  return `<section class="filters error-bar"><p>${esc(message)}</p></section>`;
}

function renderCurrencyCard(currency, data) {
  const { moneyIn, moneyOut, profit, balance } = data;
  return `
  <section class="currency-block">
    <h2>${esc(currency)}</h2>
    <div class="grid">
      <div class="metric">
        <h3>Money in (top-ups)</h3>
        <p class="big">${esc(formatMoney(moneyIn.gross, currency))}</p>
        <ul>
          <li>Bank: ${esc(formatMoney(moneyIn.bank, currency))}</li>
          <li>Momo (Mobile Money): ${esc(formatMoney(moneyIn.momo, currency))}</li>
          <li>${moneyIn.count} completed top-up(s)</li>
        </ul>
      </div>
      <div class="metric">
        <h3>Money out (sends &amp; invoices)</h3>
        <p class="big">${esc(formatMoney(moneyOut.gross, currency))}</p>
        <ul>
          <li>Bank: ${esc(formatMoney(moneyOut.bank, currency))}</li>
          <li>Momo (Mobile Money): ${esc(formatMoney(moneyOut.momo, currency))}</li>
          <li>${moneyOut.count} completed payout(s)</li>
        </ul>
      </div>
      <div class="metric highlight">
        <h3>Romela Pula profit</h3>
        <p class="big">${esc(formatMoney(profit.total, currency))}</p>
        <ul>
          <li>Service fees (markup): ${esc(formatMoney(profit.markup, currency))}</li>
          <li>FX margin: ${esc(formatMoney(profit.fxMargin, currency))}</li>
          <li>YC pass-through fees: ${esc(formatMoney(profit.ycFees, currency))}</li>
        </ul>
      </div>
      <div class="metric">
        <h3>Balance pool</h3>
        <p class="big">${esc(formatMoney(balance.topupPoolAfterProfit, currency))}</p>
        <ul>
          <li>Top-ups collected minus Romela Pula profit</li>
          <li>Net credited to user wallets: ${esc(formatMoney(balance.netCreditedToWallets, currency))}</li>
          <li>User wallet liabilities: ${esc(formatMoney(balance.userWalletLiabilities, currency))}</li>
          <li>Pool minus payouts: ${esc(formatMoney(balance.impliedFloat, currency))}</li>
        </ul>
      </div>
    </div>
  </section>`;
}

function renderTxnTable(rows) {
  if (!rows.length) {
    return '<p class="empty">No completed transactions from approved users yet.</p>';
  }

  const trs = rows.map((r) => {
    const payout = r.payoutAmount != null
      ? `${r.payoutAmount.toFixed(2)} ${esc(r.payoutCurrency)}`
      : '—';
    const profitParts = [
      `Total ${r.profit.romelaPulaProfit.toFixed(2)}`,
      r.profit.markup ? `markup ${r.profit.markup.toFixed(2)}` : null,
      r.profit.fxMargin ? `FX ${r.profit.fxMargin.toFixed(2)}` : null,
    ].filter(Boolean).join(' · ');

    return `<tr>
      <td>${esc(new Date(r.createdAt).toLocaleString())}</td>
      <td>${esc(r.typeLabel)}</td>
      <td>${esc(r.userName)}</td>
      <td>${esc(r.channel)}</td>
      <td>${r.amount.toFixed(2)} ${esc(r.currency)}</td>
      <td>${payout}</td>
      <td>${esc(profitParts)}</td>
      <td class="mono">${esc((r.reference || '').slice(0, 12))}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead>
      <tr>
        <th>Date</th><th>Type</th><th>User</th><th>Channel</th>
        <th>Amount</th><th>Recipient</th><th>Romela Pula profit</th><th>Ref</th>
      </tr>
    </thead>
    <tbody>${trs}</tbody>
  </table>`;
}

function renderDashboardPage(data, { filterError } = {}) {
  const currencies = Object.keys(data.byCurrency).sort();
  const currencyHtml = currencies.length
    ? currencies.map((c) => renderCurrencyCard(c, data.byCurrency[c])).join('')
    : '<p class="empty">No completed transactions in this date range.</p>';
  const filterBlock = filterError ? renderFilterError(filterError) : renderFilterBar(data);
  const tableNote = data.exportTransactions.length > data.transactions.length
    ? ` (showing latest ${data.transactions.length} of ${data.exportTransactions.length} — export CSV for full list)`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Romela Pula Admin Dashboard</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f8;margin:0;color:#1a1a2e}
  header{background:#1a1a2e;color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  header h1{margin:0;font-size:1.2rem}
  header .meta{font-size:.8rem;opacity:.75}
  .logout{background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.85rem}
  main{padding:24px;max-width:1200px;margin:0 auto}
  .stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:#fff;padding:16px 20px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.05);min-width:160px}
  .stat strong{display:block;font-size:1.4rem}
  .stat span{font-size:.8rem;color:#666}
  .currency-block{background:#fff;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 2px 12px rgba(0,0,0,.05)}
  .currency-block h2{margin:0 0 16px;font-size:1.1rem;border-bottom:2px solid #1a56db;padding-bottom:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
  .metric{background:#f9fafb;border-radius:10px;padding:16px}
  .metric.highlight{background:#eff6ff;border:1px solid #bfdbfe}
  .metric h3{margin:0 0 8px;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#666}
  .metric .big{margin:0 0 10px;font-size:1.35rem;font-weight:700}
  .metric ul{margin:0;padding-left:18px;font-size:.85rem;color:#444;line-height:1.6}
  .txn-section{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.05);overflow-x:auto}
  .txn-section h2{margin:0 0 16px;font-size:1.1rem}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #eee}
  th{background:#f9fafb;font-weight:600;font-size:.75rem;text-transform:uppercase;color:#666}
  .mono{font-family:ui-monospace,monospace;font-size:.8rem}
  .empty{color:#666;font-style:italic}
  .filters{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:24px;box-shadow:0 2px 12px rgba(0,0,0,.05)}
  .filter-form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px}
  .field label{display:block;font-size:.75rem;font-weight:600;color:#666;margin-bottom:4px}
  .field input[type=date]{padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:.9rem}
  .btn-primary,.btn-secondary,.btn-export{display:inline-block;padding:9px 16px;border-radius:8px;font-size:.9rem;font-weight:600;text-decoration:none;cursor:pointer;border:none}
  .btn-primary{background:#1a56db;color:#fff}
  .btn-secondary{background:#f3f4f6;color:#333;border:1px solid #ddd}
  .btn-export{background:#047857;color:#fff}
  .filter-note{display:block;margin-top:12px;font-size:.85rem;color:#666}
  .error-bar{border:1px solid #fecdca;background:#fef3f2;color:#b42318}
  .error-bar p{margin:0}
</style></head><body>
<header>
  <div>
    <h1>Romela Pula Admin</h1>
    <div class="meta">Approved users only · Updated ${esc(new Date(data.generatedAt).toLocaleString())}</div>
  </div>
  <form method="POST" action="/api/admin" style="margin:0">
    <input type="hidden" name="action" value="logout">
    <button type="submit" class="logout">Sign out</button>
  </form>
</header>
<main>
  ${filterBlock}
  <div class="stats">
    <div class="stat"><strong>${data.totals.registeredUsers}</strong><span>Approved users</span></div>
    <div class="stat"><strong>${data.totals.completedTransactions}</strong><span>In date range</span></div>
    <div class="stat"><strong>${data.exportTransactions.length}</strong><span>Exportable rows</span></div>
  </div>
  ${currencyHtml}
  <section class="txn-section">
    <h2>Transactions &amp; profit${esc(tableNote)}</h2>
    ${renderTxnTable(data.transactions)}
  </section>
</main></body></html>`;
}

module.exports = { renderLoginPage, renderDashboardPage, renderFilterBar };
