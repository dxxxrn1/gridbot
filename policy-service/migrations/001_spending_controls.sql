ALTER TABLE public.policy
  ADD COLUMN IF NOT EXISTS spending_frozen BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.staff_users
  ADD COLUMN IF NOT EXISTS daily_cap NUMERIC NULL
  CHECK (daily_cap IS NULL OR daily_cap >= 0);
