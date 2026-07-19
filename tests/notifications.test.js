jest.mock('../lib/db', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  return {
    supabase: {
      from: jest.fn(() => chain),
      _chain: chain,
    },
  };
});

const { supabase } = require('../lib/db');
const { notifyUser, stripMarkdown, listNotifications } = require('../lib/notifications');

describe('notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supabase._chain.single.mockResolvedValue({
      data: { id: 'n1', phone: '+26771234567', type: 'kyc_approved' },
      error: null,
    });
    supabase._chain.limit.mockResolvedValue({ data: [], error: null });
  });

  it('stripMarkdown removes asterisks', () => {
    expect(stripMarkdown('*Hello* world')).toBe('Hello world');
  });

  it('notifyUser inserts a notification row', async () => {
    const row = await notifyUser('+26771234567', {
      type: 'kyc_approved',
      title: 'Account verified',
      body: 'Welcome to PayLink',
      actionUrl: 'https://example.com/fees',
    });
    expect(row.id).toBe('n1');
    expect(supabase.from).toHaveBeenCalledWith('user_notifications');
  });

  it('listNotifications queries by phone', async () => {
    await listNotifications('+26771234567');
    expect(supabase.from).toHaveBeenCalledWith('user_notifications');
    expect(supabase._chain.eq).toHaveBeenCalledWith('phone', '+26771234567');
  });
});
