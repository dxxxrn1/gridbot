ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (
    status IN (
      'auto_approved',
      'blocked',
      'pending_owner',
      'owner_approving',
      'owner_approved',
      'owner_approval_unknown',
      'expired'
    )
  );

NOTIFY pgrst, 'reload schema';
