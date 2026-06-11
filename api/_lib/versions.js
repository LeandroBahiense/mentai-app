/**
 * Pallyum — Fonte única das versões dos documentos legais (LGPD).
 *
 * Importado por api/signup.js (aceite no cadastro), api/user/consent-status.js
 * (checagem de re-aceite) e api/user/reaccept.js (gravação do re-aceite).
 * Atualizar AQUI quando os Termos ou a Política de Privacidade mudarem —
 * o bump aciona o gate de re-aceite no bootstrap do app.
 */

export const TERMS_VERSION   = '2026-06-06';
export const PRIVACY_VERSION = '2026-06-06';

// Texto literal mostrado ao usuário no momento do aceite (prova LGPD).
export const CONSENT_TEXT_SHOWN = 'Li e concordo com os Termos de Uso e a Política de Privacidade, incluindo o tratamento dos meus dados pessoais conforme a LGPD.';

// Aviso de transparência Nylas (sub-processador de e-mail/agenda) — prova LGPD.
export const NYLAS_NOTICE_VERSION    = '2026-06-11';
export const NYLAS_NOTICE_TEXT_SHOWN = 'Entendi que, ao conectar esta conta, meus dados de e-mail e agenda serão tratados pela Nylas, Inc. (sub-processadora, EUA) para viabilizar os recursos de agenda do Pallyum.';
