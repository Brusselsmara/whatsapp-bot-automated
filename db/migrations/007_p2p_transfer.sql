-- Atomic PayLink-to-PayLink wallet transfer (same currency, KYC-approved users only).

create or replace function transfer_wallet_p2p(
  p_sender_phone text,
  p_recipient_phone text,
  p_currency text,
  p_amount numeric,
  p_memo text default null
)
returns table(
  claimed boolean,
  txn_id uuid,
  sender_balance numeric,
  recipient_balance numeric,
  reason text
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_sender users%rowtype;
  v_recipient users%rowtype;
  v_sender_wallet wallets%rowtype;
  v_sender_balance numeric;
  v_recipient_balance numeric;
  v_txn_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    return query select false, null::uuid, null::numeric, null::numeric, 'invalid_amount';
    return;
  end if;

  if p_sender_phone = p_recipient_phone then
    return query select false, null::uuid, null::numeric, null::numeric, 'self_transfer';
    return;
  end if;

  select * into v_sender from users where phone = p_sender_phone for update;
  if not found or v_sender.kyc_status <> 'approved' then
    return query select false, null::uuid, null::numeric, null::numeric, 'sender_not_eligible';
    return;
  end if;

  select * into v_recipient from users where phone = p_recipient_phone for update;
  if not found or v_recipient.kyc_status <> 'approved' then
    return query select false, null::uuid, null::numeric, null::numeric, 'recipient_not_eligible';
    return;
  end if;

  if v_recipient.home_currency is distinct from p_currency then
    return query select false, null::uuid, null::numeric, null::numeric, 'currency_mismatch';
    return;
  end if;

  select * into v_sender_wallet
  from wallets
  where phone = p_sender_phone and currency = p_currency
  for update;

  if not found or v_sender_wallet.balance < p_amount then
    return query select false, null::uuid, null::numeric, null::numeric, 'insufficient_funds';
    return;
  end if;

  update wallets
  set balance = balance - p_amount,
      updated_at = now()
  where phone = p_sender_phone and currency = p_currency;

  insert into wallets (phone, currency, balance, updated_at)
  values (p_recipient_phone, p_currency, p_amount, now())
  on conflict (phone, currency) do update
  set balance = wallets.balance + excluded.balance,
      updated_at = now()
  returning balance into v_recipient_balance;

  select balance into v_sender_balance
  from wallets
  where phone = p_sender_phone and currency = p_currency;

  insert into transactions (
    type,
    phone,
    amount,
    currency,
    status,
    reference,
    recipient_name,
    recipient_account_number,
    payout_amount,
    payout_currency,
    updated_at
  )
  values (
    'p2p',
    p_sender_phone,
    p_amount,
    p_currency,
    'completed',
    coalesce(nullif(trim(p_memo), ''), 'PayLink transfer'),
    coalesce(v_recipient.business_name, v_recipient.kyc_name, 'PayLink user'),
    p_recipient_phone,
    p_amount,
    p_currency,
    now()
  )
  returning id into v_txn_id;

  return query select true, v_txn_id, v_sender_balance, v_recipient_balance, null::text;
end;
$$;
