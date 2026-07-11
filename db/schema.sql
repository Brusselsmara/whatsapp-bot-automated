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

-- Per-business FX margin (default 2%; VIP corporate e.g. 0.01 = 1%)
alter table users add column if not exists fx_margin_pct numeric(6,4) default 0.02;

-- Home currency/country — derived automatically from the user's WhatsApp
-- phone number's dial code (e.g. +267... => BWP/BW). Backfilled lazily by
-- getOrCreateUser() for existing users too, so no manual migration needed.
-- This is now the user's ONLY wallet currency (see WALLETS below).
alter table users add column if not exists home_currency text;
alter table users add column if not exists home_country text;

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

-- Invoice payment fee breakdown (amount = total wallet debit; payout_amount = YC send face value)
alter table transactions add column if not exists payout_amount numeric(18,2);
alter table transactions add column if not exists yc_fee_amount numeric(18,2) default 0;
alter table transactions add column if not exists markup_amount numeric(18,2) default 0;

-- Settlement idempotency flags (row-level locking in RPC functions below)
alter table transactions add column if not exists wallet_credited boolean default false;
alter table transactions add column if not exists wallet_refunded boolean default false;

-- Live FX quote locked at payment time
alter table transactions add column if not exists quote_id text;
alter table transactions add column if not exists yc_rate numeric(18,6);
alter table transactions add column if not exists display_rate numeric(18,6);
alter table transactions add column if not exists quote_expires_at timestamptz;

-- For a "send money" transaction, `currency`/`amount` ALWAYS refer to the
-- sender's wallet (what's debited/refunded — this is what the settlement
-- RPCs below operate on). `payout_currency` records what the recipient
-- actually received when it differs from the wallet currency (cross-border
-- sends, bridged through USD internally). Same-currency sends leave this
-- null (payout_currency == currency in that case).
alter table transactions add column if not exists payout_currency text;

-- FX margin actually applied on a cross-border send, for audit/support —
-- may differ from users.fx_margin_pct when the VIP corridor rule kicked in
-- (business + BWP source + ZAR/SA destination + amount >= 500,000 BWP).
alter table transactions add column if not exists margin_pct numeric(6,4);

-- ============================================================
-- ATOMIC SETTLEMENT RPCs (SELECT … FOR UPDATE — prevents double-credit)
-- Run this block in Supabase SQL editor after the columns above exist.
-- ============================================================

create or replace function claim_topup_credit(p_txn_id uuid, p_yc_response jsonb)
returns table(claimed boolean, phone text, currency text, amount numeric, new_balance numeric)
language plpgsql
as $$
#variable_conflict use_column
declare
  v transactions%rowtype;
  v_new_balance numeric;
begin
  select * into v from transactions where id = p_txn_id for update;

  if not found
     or v.type <> 'topup'
     or v.wallet_credited
     or v.status = 'failed' then
    return query select false, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  update transactions
  set status = 'completed',
      updated_at = now(),
      raw_response = coalesce(p_yc_response, raw_response),
      wallet_credited = true
  where id = p_txn_id;

  insert into wallets (phone, currency, balance, updated_at)
  values (v.phone, v.currency, v.amount, now())
  on conflict (phone, currency) do update
  set balance = wallets.balance + excluded.balance,
      updated_at = now()
  returning wallets.balance into v_new_balance;

  return query select true, v.phone, v.currency, v.amount, v_new_balance;
end;
$$;

create or replace function mark_topup_failed(p_txn_id uuid, p_yc_response jsonb)
returns table(claimed boolean, phone text, currency text, amount numeric)
language plpgsql
as $$
declare
  v transactions%rowtype;
begin
  select * into v from transactions where id = p_txn_id for update;

  if not found
     or v.type <> 'topup'
     or v.status in ('completed', 'failed') then
    return query select false, null::text, null::text, null::numeric;
    return;
  end if;

  update transactions
  set status = 'failed',
      updated_at = now(),
      raw_response = coalesce(p_yc_response, raw_response)
  where id = p_txn_id;

  return query select true, v.phone, v.currency, v.amount;
end;
$$;

create or replace function claim_send_complete(p_txn_id uuid, p_yc_response jsonb)
returns table(claimed boolean, receipt_pending boolean, phone text, invoice_id uuid)
language plpgsql
as $$
declare
  v transactions%rowtype;
begin
  select * into v from transactions where id = p_txn_id for update;

  if not found
     or v.type not in ('send', 'invoice_payment')
     or v.status in ('completed', 'failed') then
    return query select false, false, null::text, null::uuid;
    return;
  end if;

  update transactions
  set status = 'completed',
      updated_at = now(),
      raw_response = coalesce(p_yc_response, raw_response)
  where id = p_txn_id;

  return query select true, not v.receipt_sent, v.phone, v.invoice_id;
end;
$$;

create or replace function claim_send_refund(p_txn_id uuid, p_yc_response jsonb)
returns table(claimed boolean, phone text, currency text, amount numeric, new_balance numeric)
language plpgsql
as $$
#variable_conflict use_column
declare
  v transactions%rowtype;
  v_new_balance numeric;
begin
  select * into v from transactions where id = p_txn_id for update;

  if not found
     or v.type not in ('send', 'invoice_payment')
     or v.wallet_refunded
     or v.status = 'completed' then
    return query select false, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  update transactions
  set status = 'failed',
      updated_at = now(),
      raw_response = coalesce(p_yc_response, raw_response),
      wallet_refunded = true
  where id = p_txn_id;

  insert into wallets (phone, currency, balance, updated_at)
  values (v.phone, v.currency, v.amount, now())
  on conflict (phone, currency) do update
  set balance = wallets.balance + excluded.balance,
      updated_at = now()
  returning wallets.balance into v_new_balance;

  return query select true, v.phone, v.currency, v.amount, v_new_balance;
end;
$$;

create or replace function claim_receipt_sent(p_txn_id uuid)
returns table(claimed boolean)
language plpgsql
as $$
declare
  v transactions%rowtype;
begin
  select * into v from transactions where id = p_txn_id for update;

  if not found or v.receipt_sent or v.status <> 'completed' then
    return query select false;
    return;
  end if;

  update transactions set receipt_sent = true where id = p_txn_id;
  return query select true;
end;
$$;

create index if not exists idx_transactions_yc_ref on transactions(yellowcard_reference);
create index if not exists idx_invoices_code on invoices(invoice_code);
create index if not exists idx_kyc_token on kyc_submissions(approval_token);
-- Allow 'more_info_requested' as a valid kyc_submissions status
-- (no constraint to change, status is just text — this comment is a note)
-- Existing status values: pending | approved | rejected | more_info_requested

-- Index for faster session lookups during resubmission flow
create index if not exists idx_sessions_phone on sessions(phone);

-- Track how many times a user has resubmitted documents
alter table kyc_submissions add column if not exists resubmission_count integer default 0;

-- Persist the admin's note when requesting more info, so there's a
-- record of what was asked for even after a new submission row is created
alter table kyc_submissions add column if not exists note text;