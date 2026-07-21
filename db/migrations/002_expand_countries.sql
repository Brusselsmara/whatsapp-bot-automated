-- Expand Romela Pula to all Yellow Card Africa corridors (see lib/yellowcard.js COUNTRY_CONFIG).
-- Safe to re-run.

-- Invoice country (required for shared currencies like XOF / XAF)
alter table invoices add column if not exists country text;

-- Backfill country on existing invoices where currency maps uniquely
update invoices set country = 'BW' where country is null and currency = 'BWP';
update invoices set country = 'ZA' where country is null and currency = 'ZAR';
update invoices set country = 'ZM' where country is null and currency = 'ZMW';
update invoices set country = 'KE' where country is null and currency = 'KES';
update invoices set country = 'NG' where country is null and currency = 'NGN';
update invoices set country = 'MW' where country is null and currency = 'MWK';
update invoices set country = 'RW' where country is null and currency = 'RWF';
update invoices set country = 'TZ' where country is null and currency = 'TZS';
update invoices set country = 'UG' where country is null and currency = 'UGX';
