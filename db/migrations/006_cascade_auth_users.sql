-- ============================================================
-- Pallyum — Migration 006: ON DELETE CASCADE nas FKs de conteúdo
-- ============================================================
-- ⛔ PASSO 4 — SÓ RODAR após o Passo 3 aplicado e verificado.
--
-- Nomes das constraints confirmados no banco de produção
-- (qmsuykfqtiqaauinehfu) via pg_constraint antes de aplicar.
-- Os nomes abaixo seguem a convenção Postgres padrão.
-- Se diferirem, ajustar antes de rodar.
--
-- NÃO TOCAR nas demais FKs do schema:
--   organizations.admin_user_id       → ON DELETE SET NULL  (intencional)
--   upgrade_requests.resolved_by      → ON DELETE SET NULL  (intencional)
--   usage_logs, note_embeddings,
--   org_members, upgrade_requests     → já CASCADE (migration 2026-05-18)
-- ============================================================

-- ── notes ────────────────────────────────────────────────────
ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_user_id_fkey;
ALTER TABLE public.notes
  ADD  CONSTRAINT notes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
-- ROLLBACK: ADD CONSTRAINT notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE NO ACTION;

-- ── phone_users ───────────────────────────────────────────────
ALTER TABLE public.phone_users
  DROP CONSTRAINT IF EXISTS phone_users_user_id_fkey;
ALTER TABLE public.phone_users
  ADD  CONSTRAINT phone_users_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
-- ROLLBACK: ADD CONSTRAINT phone_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE NO ACTION;

-- ── user_preferences ─────────────────────────────────────────
ALTER TABLE public.user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_user_id_fkey;
ALTER TABLE public.user_preferences
  ADD  CONSTRAINT user_preferences_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
-- ROLLBACK: ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE NO ACTION;

-- ============================================================
-- FIM DO PASSO 4
-- ============================================================
