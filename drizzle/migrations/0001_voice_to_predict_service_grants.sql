grant all on public.callers, public.intents, public.orders, public.activity, public.receipts, public.settings to service_role;
grant usage, select on sequence public.activity_id_seq to service_role;