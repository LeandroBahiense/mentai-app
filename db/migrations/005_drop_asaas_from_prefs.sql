-- ============================================================
-- Pallyum — Migration 005: remover colunas Asaas de user_preferences
-- ============================================================
-- ⛔ PASSO 3 — SÓ RODAR após:
--   1. Passo 1 (004_create_subscriptions.sql) aplicado ✓
--   2. Código do Passo 2 em produção ✓
--   3. Cobrança verificada: pelo menos 1 webhook recebido com sucesso
--      após o deploy, confirmado nos logs do Vercel.
-- Rodar antes disso derruba a cobrança.
-- ============================================================

ALTER TABLE public.user_preferences
  DROP COLUMN IF EXISTS asaas_customer_id;

ALTER TABLE public.user_preferences
  DROP COLUMN IF EXISTS asaas_subscription_id;

-- ============================================================
-- FIM DO PASSO 3
-- ============================================================
