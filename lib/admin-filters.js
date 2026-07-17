/** Parse YYYY-MM-DD admin dashboard date filters from query params. */
function parseDateFilters(query = {}) {
  const fromStr = normalizeDateStr(query.from);
  const toStr = normalizeDateStr(query.to);

  if (fromStr && toStr && fromStr > toStr) {
    return { error: 'Start date must be on or before end date.' };
  }

  return {
    from: fromStr ? startOfDayUtc(fromStr) : null,
    to: toStr ? endOfDayUtc(toStr) : null,
    fromLabel: fromStr,
    toLabel: toStr,
  };
}

function normalizeDateStr(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(`${trimmed}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return trimmed;
}

function startOfDayUtc(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function endOfDayUtc(dateStr) {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function isTxnInRange(txn, filters) {
  if (!filters?.from && !filters?.to) return true;
  const created = new Date(txn.created_at);
  if (Number.isNaN(created.getTime())) return false;
  if (filters.from && created < filters.from) return false;
  if (filters.to && created > filters.to) return false;
  return true;
}

function filtersQueryString(filters) {
  const params = new URLSearchParams();
  if (filters?.fromLabel) params.set('from', filters.fromLabel);
  if (filters?.toLabel) params.set('to', filters.toLabel);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

module.exports = {
  parseDateFilters,
  isTxnInRange,
  filtersQueryString,
};
