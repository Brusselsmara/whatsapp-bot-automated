-- WhatsApp customer service window + customer-initiated PWA activation.
-- Safe to run on existing databases.

alter table users add column if not exists last_whatsapp_inbound_at timestamptz;
alter table users add column if not exists pwa_activated_at timestamptz;
