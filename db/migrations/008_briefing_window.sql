-- ===== INÍCIO — schema window-aware do briefing =====

-- (1) rastrear último inbound por telefone (PK de phone_users é phone)
ALTER TABLE public.phone_users
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;

-- (2) cache do briefing — 1 linha por usuário, sobrescreve.
--     Contém PII (texto do briefing) → FK CASCADE + RLS service_role-only,
--     mesmo padrão da subscriptions.
CREATE TABLE IF NOT EXISTS public.briefing_cache (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  texto          text NOT NULL,
  n_compromissos integer NOT NULL DEFAULT 0,
  n_urgentes     integer NOT NULL DEFAULT 0,
  gerado_em      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.briefing_cache ENABLE ROW LEVEL SECURITY;
-- sem policy: nega por padrão; só service_role (backend) acessa.

-- ===== FIM =====
