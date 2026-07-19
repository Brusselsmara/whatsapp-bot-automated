/** PWA quick-reply parsing — shared by api/app.js and tests. */

function shouldShowQuickReplies(session, reply) {
  if (session?.state === 'register_documents') return false;

  const text = String(reply || '');
  if (/Documents required for/i.test(text)) return false;
  if (/Additional documents needed/i.test(text)) return false;
  if (/Please attach a document/i.test(text)) return false;
  if (/Got it \(\d+ document/i.test(text)) return false;
  if (/send each document as a clear photo/i.test(text)) return false;

  return true;
}

function parseQuickReplies(text, session) {
  if (!shouldShowQuickReplies(session, text)) return [];

  const replies = [];
  const lines = String(text || '').split('\n');
  const isDocChecklist =
    /Documents required for|Full document checklist|Additional documents needed/i.test(text);

  for (const line of lines) {
    const trimmed = line.trim();
    if (isDocChecklist && /^\d+\.\s/.test(trimmed)) continue;

    const m = trimmed.match(/^(\d+)️⃣\s*(.+)$/) || trimmed.match(/^(\d+)[\.)]\s*(.+)$/);
    if (!m) continue;

    const label = m[2].trim();
    if (label.length > 80) continue;

    replies.push({ value: m[1], label });
  }

  if (replies.length === 0 && /reply\s+"?1"?/i.test(text)) {
    replies.push({ value: '1', label: 'Register' });
  }

  return replies;
}

module.exports = { shouldShowQuickReplies, parseQuickReplies };
