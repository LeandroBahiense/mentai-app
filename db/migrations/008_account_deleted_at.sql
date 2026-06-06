ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS account_deleted_at timestamptz NULL;

COMMENT ON COLUMN public.user_preferences.account_deleted_at IS
  'Soft-delete de conta (LGPD Art.18 IV/VI). Setado no pedido de exclusao; login dentro de 30d restaura (zera); expurgo D+30 no cron daily-usage.';
