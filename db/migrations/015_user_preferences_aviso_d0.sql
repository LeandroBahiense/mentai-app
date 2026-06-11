ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS aviso_d0_validade timestamptz;
