-- Proactive PayLink PWA chat messages (PDF receipts, transfer declines, etc.).
-- Safe to run on existing databases.

create table if not exists app_messages (
  id uuid primary key default uuid_generate_v4(),
  phone text not null references users(phone),
  text text not null,
  action_url text,
  action_label text,
  delivered_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists app_messages_undelivered_idx
  on app_messages (phone, created_at desc)
  where delivered_at is null;
