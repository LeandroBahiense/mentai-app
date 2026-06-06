/**
 * Pallyum — Signup com aceite LGPD (Termos + Privacidade)
 *
 * Centraliza o cadastro no backend para:
 *  1. Capturar IP e User-Agent server-side (não-forjáveis)
 *  2. Gravar prova de consentimento em user_consents (terms + privacy)
 *  3. Garantir atomicidade: se gravar consentimento falhar, deleta o user (rollback)
 *
 * Login NÃO passa por aqui — continua chamando o SDK direto.
 */

import { createClient } from '@supabase/supabase-js';
import { TERMS_VERSION, PRIVACY_VERSION, CONSENT_TEXT_SHOWN } from './_lib/versions.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ── 1. Validar payload ──────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  const { email, password, acceptTerms, acceptPrivacy } = body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email obrigatório' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Senha obrigatória' });
  }
  if (acceptTerms !== true || acceptPrivacy !== true) {
    return res.status(400).json({ error: 'É obrigatório aceitar os Termos de Uso e a Política de Privacidade' });
  }

  // ── 2. Capturar IP e User-Agent (server-side, confiável) ────────────────────
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  // ── 3. Criar usuário no Supabase Auth (anon key, dispara email de confirmação) ──
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signUpData, error: signUpError } = await supabaseAuth.auth.signUp({ email, password });

  if (signUpError) {
    console.warn('[api/signup] supabase signUp error:', signUpError.message);
    return res.status(400).json({ error: signUpError.message });
  }

  // Caso especial: Supabase pode retornar user com identities vazio se o email
  // já está cadastrado (não vaza essa info via erro, por design de segurança)
  if (signUpData?.user && Array.isArray(signUpData.user.identities) && signUpData.user.identities.length === 0) {
    return res.status(400).json({ error: 'Este e-mail já está cadastrado. Tente fazer login ou recuperar a senha.' });
  }

  if (!signUpData?.user?.id) {
    console.error('[api/signup] signUp retornou sem user.id:', signUpData);
    return res.status(500).json({ error: 'Falha ao criar conta. Tente novamente em alguns instantes.' });
  }

  const userId = signUpData.user.id;

  // ── 4. Gravar consentimentos em user_consents (service_role bypassa RLS) ────
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const consentRows = [
    {
      user_id:     userId,
      doc_type:    'terms',
      doc_version: TERMS_VERSION,
      ip,
      user_agent:  userAgent,
      text_shown:  CONSENT_TEXT_SHOWN,
    },
    {
      user_id:     userId,
      doc_type:    'privacy',
      doc_version: PRIVACY_VERSION,
      ip,
      user_agent:  userAgent,
      text_shown:  CONSENT_TEXT_SHOWN,
    },
  ];

  const { error: consentError } = await supabaseAdmin.from('user_consents').insert(consentRows);

  if (consentError) {
    // ── 5. Rollback: deletar o user pra não deixar conta sem prova de consentimento
    console.error('[api/signup] Falha ao gravar user_consents:', consentError.message);
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteError) {
      // Falha dupla (raríssima): user criado, consent não gravado, delete falhou.
      // Loga em CRÍTICO pra investigação manual. Retorna erro pro cliente.
      console.error('[api/signup] CRÍTICO: rollback falhou. user_id=' + userId + ' | erro=' + deleteError.message);
    }
    return res.status(500).json({ error: 'Falha ao registrar consentimento. Tente novamente em alguns instantes.' });
  }

  console.log(`[api/signup] OK | uid=${userId} | terms=${TERMS_VERSION} | privacy=${PRIVACY_VERSION} | ip=${ip}`);

  // ── 6. Sucesso ──────────────────────────────────────────────────────────────
  // user.confirmation_sent_at vem preenchido quando Confirm Email está ligado.
  return res.status(200).json({
    ok: true,
    message: 'Conta criada! Verifique seu e-mail para confirmar.',
  });
}
