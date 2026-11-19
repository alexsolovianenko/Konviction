-- Voice-to-Predict schema. All tables are written and read only by edge functions
-- (service role). RLS is enabled with no policies, so the public anon key can't read them.

create table if not exists public.callers (
  phone text primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  call_count int not null default 0,
  pin_failures int not null default 0,
  locked_until timestamptz
);

create table if not exists public.intents (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  caller text not null,
  conversation_id text,
  side text not null check (side in ('buy','sell')),
  event_ticker text not null,
  instrument_symbol text not null,
  title text,
  contract_label text,
  outcome text not null check (outcome in ('yes','no')),
  quantity int not null check (quantity > 0),
  limit_price numeric(6,4) not null,
  notional_usd numeric(10,2) not null,
  est_fee_usd numeric(10,2) not null,
  quote_price numeric(6,4),
  quote_at timestamptz,
  contract_expiry timestamptz,
  expires_at timestamptz not null,
  status text not null default 'PROPOSED'
    check (status in ('PROPOSED','EXECUTING','DONE','EXPIRED','SUPERSEDED','REJECTED','FAILED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid unique not null references public.intents(id),
  side text not null,
  gemini_order_id text unique,
  outcome_summary text not null
    check (outcome_summary in ('FILLED','PARTIAL','NOT_FILLED','PENDING_UNKNOWN','EXCHANGE_REJECTED')),
  exchange_status text,
  filled_qty numeric,
  remaining_qty numeric,
  avg_price numeric,
  filled_notional_usd numeric(10,2) not null default 0,
  error text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.activity (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,
  caller text,
  summary text not null,
  detail jsonb
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.intents(id),
  kind text not null check (kind in ('approval','result')),
  payload_text text not null,
  sha256 text not null,
  solana_sig text,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

insert into public.settings (key, value) values ('execution_enabled', 'true'::jsonb)
  on conflict (key) do nothing;

alter table public.callers  enable row level security;
alter table public.intents  enable row level security;
alter table public.orders   enable row level security;
alter table public.activity enable row level security;
alter table public.receipts enable row level security;
alter table public.settings enable row level security;

create index if not exists activity_at_idx on public.activity (at desc);
create index if not exists intents_caller_status_idx on public.intents (caller, status);
create index if not exists orders_created_idx on public.orders (created_at desc);
