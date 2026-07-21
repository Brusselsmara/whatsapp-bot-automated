-- In-app notifications for the Romela Pula PWA (replaces proactive WhatsApp alerts).
-- Safe to run on existing databases.

create table if not exists user_notifications (
  id uuid primary key default uuid_generate_v4(),
  phone text not null references users(phone),
  type text not null default 'general',
  title text not null,
  body text not null,
  action_url text,
  read_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists user_notifications_phone_created_idx
  on user_notifications (phone, created_at desc);

create index if not exists user_notifications_unread_idx
  on user_notifications (phone) where read_at is null;
