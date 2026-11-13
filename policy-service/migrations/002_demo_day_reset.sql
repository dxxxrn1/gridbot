ALTER TABLE public.policy
  ADD COLUMN IF NOT EXISTS demo_day_started_at TIMESTAMPTZ NULL;

NOTIFY pgrst, 'reload schema';
