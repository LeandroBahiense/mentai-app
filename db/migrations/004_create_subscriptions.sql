-- ============================================================
-- Pallyum — Migration 004: tabela subscriptions
-- STATUS: PASSO 1 — aditivo, não-destrutivo. Seguro de rodar.
-- As colunas asaas_customer_id / asaas_subscription_id continuam
-- em user_preferences até o Passo 3. Não quebra nada.
-- ============================================================

-- 1. Tabela subscriptions
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  asaas_customer_id     text,
  asaas_subscription_id text,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- 2. Um registro por usuário (enquanto o usuário existir).
--    Constraint simples (não parcial) — o PostgREST não consegue mirar índice
--    parcial no ?on_conflict (erro 42P10). NULLs resultantes do ON DELETE SET NULL
--    são permitidos em múltiplas linhas porque o Postgres trata NULLs como distintos.
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);

-- 3. RLS habilitado, sem policy pública — acesso exclusivo via service_role
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
-- (sem CREATE POLICY — mesma decisão de deleted_notes e admin_audit)

-- 4. Backfill: copia dados existentes de user_preferences
--    Idempotente: ON CONFLICT DO NOTHING protege reexecuções
INSERT INTO public.subscriptions (user_id, asaas_customer_id, asaas_subscription_id)
SELECT
  user_id,
  asaas_customer_id,
  asaas_subscription_id
FROM public.user_preferences
WHERE asaas_customer_id IS NOT NULL
   OR asaas_subscription_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ============================================================
-- FIM DO PASSO 1
-- Próximo passo: deploy do código (Passo 2) via GitHub.
-- Só depois do código no ar rodar o Passo 3.
-- ============================================================
