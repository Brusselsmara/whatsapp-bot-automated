-- PWA document uploads (KYC) and optional login audit.
-- Safe to run on existing databases.

create table if not exists app_documents (
  id uuid primary key default uuid_generate_v4(),
  phone text not null,
  filename text,
  content_type text,
  data_base64 text not null,
  created_at timestamptz default now()
);

create index if not exists app_documents_phone_idx on app_documents (phone);
