alter table public.intents add column time_in_force text not null default 'immediate-or-cancel'
  check (time_in_force in ('immediate-or-cancel', 'good-til-cancel'));
--> statement-breakpoint
alter table public.orders drop constraint orders_outcome_summary_check,
  add constraint orders_outcome_summary_check
  check (outcome_summary in ('FILLED','PARTIAL','OPEN','NOT_FILLED','PENDING_UNKNOWN','EXCHANGE_REJECTED'));
