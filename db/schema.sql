-- Run this in the Supabase SQL editor. If you already ran the old schema,
-- run this too — it uses "create table if not exists" and "add column if
-- not exists" so it's safe to run on top of the old one.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto"; -- for gen_random_bytes, used in approval tokens

-- ============================================================
-- USERS — one row per WhatsApp phone number
-- ============================================================
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  phone text unique not null,
  display_name text,
  country text,
  account_type text default 'individual',   -- 'individual' or 'business'
  business_name text,

  -- KYC/KYB state machine
  kyc_status text default 'unregistered',   -- unregistered | pending_review | approved | rejected
  kyc_name text,
  kyc_dob text,
  kyc_address text,
  kyc_id_type text,
  kyc_id_number text,
  kyc_email text,

  created_at timestamptz default now()
);

alter table users add column if not exists kyc_status text default 'unregistered';
alter table users add column if not exists kyc_name text;
alter table users add column if not exists kyc_dob text;
alter table users add column if not exists kyc_address text;
alter table users add column if not exists kyc_id_type text;
alter table users add column if not exists kyc_id_number text;
alter table users add column if not exists kyc_email text;

-- ============================================================
-- KYC SUBMISSIONS — one row per registration attempt, holds the
-- document links and the approve/reject token you click in email
-- ============================================================
create table if not exists kyc_submissions (
  id uuid primary key default uuid_generate_v4(),
  phone text not null references users(phone),
  document_urls text[] default '{}',        -- Twilio media URLs collected from WhatsApp
  status text default 'pending',            -- pending | approved | rejected
  approval_token text unique not null default encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz default now(),
  decided_at timestamptz
);

-- ============================================================
-- SESSIONS — conversation state machine, one row per phone number
-- ============================================================
create table if not exists sessions (
  phone text primary key,
  state text default 'idle',
  context jsonb default '{}',
  updated_at timestamptz default now()
);

-- ============================================================
-- WALLETS — internal balance per user per currency
-- ============================================================
create table if not exists wallets (
  phone text not null references users(phone),
  currency text not null,                   -- BWP, ZAR, ZMW
  balance numeric(18,2) not null default 0,
  updated_at timestamptz default now(),
  primary key (phone, currency)
);

-- ============================================================
-- INVOICES — kept for reference/status-lookup by code, though the
-- new flow mainly uses direct supplier-payment (see transactions).
-- ============================================================
create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  invoice_code text unique not null,
  issuer_phone text references users(phone),
  payer_phone text,
  amount numeric(18,2) not null,
  currency text not null,
  description text,
  status text default 'pending',
  yellowcard_reference text,
  created_at timestamptz default now(),
  paid_at timestamptz
);

-- ============================================================
-- TRANSACTIONS — every wallet movement: top-ups (money in),
-- sends/invoice payments (money out of wallet to a recipient)
-- ============================================================
create table if not exists transactions (
  id uuid primary key default uuid_generate_v4(),
  type text not null,                 -- 'topup' | 'send' | 'invoice_payment'
  phone text not null references users(phone),
  invoice_id uuid references invoices(id),
  amount numeric(18,2) not null,
  currency text not null,
  status text default 'pending',      -- pending | processing | completed | failed
  reference text,                     -- payment reference the customer provided (for invoice_payment)
  recipient_name text,
  recipient_account_number text,
  recipient_channel_type text,        -- bank | momo
  yellowcard_reference text unique,
  raw_response jsonb,
  receipt_sent boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table transactions add column if not exists phone text;
alter table transactions add column if not exists reference text;
alter table transactions add column if not exists recipient_name text;
alter table transactions add column if not exists recipient_account_number text;
alter table transactions add column if not exists recipient_channel_type text;
alter table transactions add column if not exists receipt_sent boolean default false;

create index if not exists idx_transactions_yc_ref on transactions(yellowcard_reference);
create index if not exists idx_invoices_code on invoices(invoice_code);
create index if not exists idx_kyc_token on kyc_submissions(approval_token);
