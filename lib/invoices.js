const { supabase } = require('./db');
const { publicAppUrl } = require('./app-url');

const INVOICE_CODE_RE = /^INV-[A-Z0-9-]{4,32}$/i;

function normalizeInvoiceCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized || !INVOICE_CODE_RE.test(normalized)) return null;
  return normalized;
}

function buildInvoicePaymentUrl(code) {
  const normalized = normalizeInvoiceCode(code);
  if (!normalized) return null;
  const base = publicAppUrl(`/pay/${encodeURIComponent(normalized)}`);
  return base || null;
}

async function loadInvoiceRow(code) {
  const normalized = normalizeInvoiceCode(code);
  if (!normalized) return null;

  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('invoice_code', normalized)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return invoice || null;
}

async function getMerchantDisplayName(issuerPhone) {
  if (!issuerPhone) return 'Merchant';
  const { data: issuer } = await supabase
    .from('users')
    .select('kyc_name, business_name')
    .eq('phone', issuerPhone)
    .maybeSingle();
  return issuer?.business_name || issuer?.kyc_name || 'Merchant';
}

/** Public invoice preview — no PII beyond merchant display name. */
async function getPublicInvoice(code) {
  const invoice = await loadInvoiceRow(code);
  if (!invoice) return null;

  const merchantName = await getMerchantDisplayName(invoice.issuer_phone);
  const normalized = normalizeInvoiceCode(invoice.invoice_code);

  return {
    code: normalized,
    amount: parseFloat(invoice.amount),
    currency: invoice.currency,
    country: invoice.country || null,
    description: invoice.description || '',
    status: invoice.status,
    merchantName,
    paymentUrl: buildInvoicePaymentUrl(normalized),
    payable: invoice.status === 'pending',
  };
}

module.exports = {
  normalizeInvoiceCode,
  buildInvoicePaymentUrl,
  loadInvoiceRow,
  getPublicInvoice,
  getMerchantDisplayName,
};
