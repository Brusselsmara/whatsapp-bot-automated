const { parseQuickReplies, shouldShowQuickReplies } = require('../lib/app-ui');

describe('app-ui quick replies', () => {
  it('suppresses chips during document upload', () => {
    const reply =
      '📋 Documents required for Individual (KYC) verification:\n\n' +
      '1. Government-issued photo ID\n' +
      '2. Proof of address\n\n' +
      'Please send each document as a clear photo or PDF.';

    expect(parseQuickReplies(reply, { state: 'register_documents' })).toEqual([]);
    expect(parseQuickReplies(reply, { state: 'idle' })).toEqual([]);
    expect(shouldShowQuickReplies({ state: 'register_documents' }, reply)).toBe(false);
  });

  it('parses menu-style numbered replies', () => {
    const reply = 'What would you like to do?\n\n1️⃣ Send money\n2️⃣ Top-up Balance';
    expect(parseQuickReplies(reply, { state: 'idle' })).toEqual([
      { value: '1', label: 'Send money' },
      { value: '2', label: 'Top-up Balance' },
    ]);
  });

  it('suppresses chips after document received ack', () => {
    const reply = 'Got it (2 document(s) so far). Send more, or reply "done" when finished.';
    expect(parseQuickReplies(reply, { state: 'register_documents' })).toEqual([]);
  });
});
