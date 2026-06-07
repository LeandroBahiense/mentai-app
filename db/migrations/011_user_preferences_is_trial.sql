-- 011_user_preferences_is_trial.sql
-- Bloco B: flag explícito de trial em user_preferences.
-- true  = usuário em teste grátis (trial-grant, antes da 1ª cobrança confirmada)
-- false = pagante ativo (após PAYMENT_CONFIRMED)
-- null  = legado / sem assinatura (tratado como "não-trial" no client)
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS is_trial boolean;
