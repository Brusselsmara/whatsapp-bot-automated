-- ============================================================
-- Row Level Security — deny direct client access via anon/authenticated.
-- The Vercel backend uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS.
-- Run in Supabase SQL editor after db/schema.sql.
-- ============================================================

-- users
alter table users enable row level security;
drop policy if exists deny_anon_users on users;
drop policy if exists deny_authenticated_users on users;
create policy deny_anon_users on users for all to anon using (false);
create policy deny_authenticated_users on users for all to authenticated using (false);

-- kyc_submissions
alter table kyc_submissions enable row level security;
drop policy if exists deny_anon_kyc_submissions on kyc_submissions;
drop policy if exists deny_authenticated_kyc_submissions on kyc_submissions;
create policy deny_anon_kyc_submissions on kyc_submissions for all to anon using (false);
create policy deny_authenticated_kyc_submissions on kyc_submissions for all to authenticated using (false);

-- sessions
alter table sessions enable row level security;
drop policy if exists deny_anon_sessions on sessions;
drop policy if exists deny_authenticated_sessions on sessions;
create policy deny_anon_sessions on sessions for all to anon using (false);
create policy deny_authenticated_sessions on sessions for all to authenticated using (false);

-- wallets
alter table wallets enable row level security;
drop policy if exists deny_anon_wallets on wallets;
drop policy if exists deny_authenticated_wallets on wallets;
create policy deny_anon_wallets on wallets for all to anon using (false);
create policy deny_authenticated_wallets on wallets for all to authenticated using (false);

-- invoices
alter table invoices enable row level security;
drop policy if exists deny_anon_invoices on invoices;
drop policy if exists deny_authenticated_invoices on invoices;
create policy deny_anon_invoices on invoices for all to anon using (false);
create policy deny_authenticated_invoices on invoices for all to authenticated using (false);

-- transactions
alter table transactions enable row level security;
drop policy if exists deny_anon_transactions on transactions;
drop policy if exists deny_authenticated_transactions on transactions;
create policy deny_anon_transactions on transactions for all to anon using (false);
create policy deny_authenticated_transactions on transactions for all to authenticated using (false);
