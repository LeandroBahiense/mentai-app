-- ============================================================
-- Pallyum — Migration 007: descartar backup órfão de 01/06/2026
-- ============================================================
-- ⛔ PASSO 5 — pode rodar independente dos passos anteriores,
--    mas incluído aqui para manter a sequência do bloco.
--
-- Tabela: public.user_preferences_backup_20260601
-- Origem: backup manual criado em 01/06/2026 antes de uma migration.
--         Contém dados pessoais (email, telefone, plano) e já cumpriu
--         seu papel. Manter seria risco LGPD desnecessário.
-- ============================================================

DROP TABLE IF EXISTS public.user_preferences_backup_20260601;

-- ============================================================
-- FIM DO PASSO 5
-- ============================================================
