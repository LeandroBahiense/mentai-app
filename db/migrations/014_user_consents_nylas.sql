BEGIN;
ALTER TABLE public.user_consents DROP CONSTRAINT user_consents_doc_type_check;
ALTER TABLE public.user_consents ADD CONSTRAINT user_consents_doc_type_check
  CHECK (doc_type = ANY (ARRAY['terms'::text, 'privacy'::text, 'briefing'::text, 'nylas'::text]));
COMMIT;
