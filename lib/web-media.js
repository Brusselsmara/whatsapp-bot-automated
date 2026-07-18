const { supabase } = require('./db');

/**
 * Store a KYC document uploaded from the PWA.
 * Returns a ref string stored in kyc_submissions.document_urls.
 */
async function storeWebDocument(phone, { base64, contentType, filename }) {
  const { data, error } = await supabase
    .from('app_documents')
    .insert({
      phone,
      filename: filename || 'document',
      content_type: contentType || 'application/octet-stream',
      data_base64: base64,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to store document: ${error.message}`);
  return `web:${data.id}`;
}

async function downloadWebDocument(ref) {
  const id = ref.startsWith('web:') ? ref.slice(4) : ref;
  const { data, error } = await supabase
    .from('app_documents')
    .select('filename, content_type, data_base64')
    .eq('id', id)
    .single();

  if (error || !data) throw new Error(`Web document not found: ${id}`);

  return {
    base64: data.data_base64,
    contentType: data.content_type,
    filename: data.filename || 'document',
  };
}

module.exports = { storeWebDocument, downloadWebDocument };
