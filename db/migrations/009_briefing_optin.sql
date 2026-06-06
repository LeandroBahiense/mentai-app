ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS briefing_optin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_preferences.briefing_optin IS
  'Opt-in afirmativo do briefing proativo no WhatsApp (base de consentimento LGPD). Default false; consentimento em user_consents (doc_type=briefing).';
