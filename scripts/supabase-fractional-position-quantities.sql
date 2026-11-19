-- Run once when upgrading the alternative Supabase ledger from its integer
-- quantity schema. Existing proposal quantities and constraints are preserved.
ALTER TABLE public.intents ALTER COLUMN quantity TYPE numeric USING quantity::numeric;
