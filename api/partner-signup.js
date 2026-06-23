/**
 * Pallyum — Cadastro Design Partner (porta dos amigos — DESCARTÁVEL)
 *
 * POST /api/partner-signup
 *
 * Porta SEPARADA e descartável para a fase de amigos. Cria a conta exatamente
 * como o /api/signup (auth + prova de consentimento LGPD), MAS deixa a conta
 * INERTE: grava plano='gratuito' com plano_validade no passado distante
 * (sentinela ano 2000), o que aciona o modo-leitura existente (Etapa 04) SEM
 * inventar trinco novo. NÃO seleciona plano, NÃO inicia trial, NÃO pede cartão.
 *
 * A validade-sentinela é PROPOSITALMENTE antiga (fora da janela de 48h do aviso
 * "acesso pausado") para que NENHUM e-mail automático saia. Só o e-mail de
 * confirmação do cadastro (o "e-mail inicial" permitido).
 *
 * O owner acende a conta manualmente no Admin (grant Design Partner → validade
 * +30 dias → conta abre). A porta de pagantes (/api/signup + checkout) fica
 * 100% INTOCADA. Este arquivo pode ser DELETADO após a fase de amigos sem
 * afetar as contas DP já criadas (são linhas normais de assinatura).
 *
 * Login NÃO passa por aqui — continua chamando o SDK direto.
 */

import { createClient } from '@supabase/supabase-js';
import { TERMS_VERSION, PRIVACY_VERSION, CONSENT_TEXT_SHOWN } from './_lib/versions.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validade-sentinela no passado distante: deixa a conta INERTE (modo leitura)
// e FORA da janela de 48h do aviso "acesso pausado" → zero e-mail automático.
const PARTNER_INERT_VALIDADE = '2000-01-01T00:00:00.000Z';

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
    console.warn('[api/partner-signup] supabase signUp error:', signUpError.message);
    return res.status(400).json({ error: signUpError.message });
  }

  if (signUpData?.user && Array.isArray(signUpData.user.identities) && signUpData.user.identities.length === 0) {
    return res.status(400).json({ error: 'Este e-mail já está cadastrado. Tente fazer login ou recuperar a senha.' });
  }

  if (!signUpData?.user?.id) {
    console.error('[api/partner-signup] signUp retornou sem user.id:', signUpData);
    return res.status(500).json({ error: 'Falha ao criar conta. Tente novamente em alguns instantes.' });
  }

  const userId = signUpData.user.id;

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── 4. Gravar consentimentos em user_consents (service_role bypassa RLS) ────
  const consentRows = [
    { user_id: userId, doc_type: 'terms',   doc_version: TERMS_VERSION,   ip, user_agent: userAgent, text_shown: CONSENT_TEXT_SHOWN },
    { user_id: userId, doc_type: 'privacy', doc_version: PRIVACY_VERSION, ip, user_agent: userAgent, text_shown: CONSENT_TEXT_SHOWN },
  ];

  const { error: consentError } = await supabaseAdmin.from('user_consents').insert(consentRows);

  if (consentError) {
    // Rollback: deletar o user pra não deixar conta sem prova de consentimento
    console.error('[api/partner-signup] Falha ao gravar user_consents:', consentError.message);
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteError) {
      console.error('[api/partner-signup] CRÍTICO: rollback (consent) falhou. user_id=' + userId + ' | erro=' + deleteError.message);
    }
    return res.status(500).json({ error: 'Falha ao registrar consentimento. Tente novamente em alguns instantes.' });
  }

  // ── 5. Deixar a conta INERTE (modo leitura) — plano gratuito + validade-sentinela ──
  // upsert por user_id: cobre tanto a linha já criada pelo trigger quanto a sua ausência.
  // Se falhar, faz rollback (deleta o user) pra NÃO deixar conta meio-aberta.
  const { error: planError } = await supabaseAdmin
    .from('subscriptions')
    .upsert(
      { user_id: userId, plano: 'gratuito', plano_validade: PARTNER_INERT_VALIDADE, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

  if (planError) {
    console.error('[api/partner-signup] Falha ao deixar conta inerte:', planError.message);
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteError) {
      console.error('[api/partner-signup] CRÍTICO: rollback (inerte) falhou. user_id=' + userId + ' | erro=' + deleteError.message);
    }
    return res.status(500).json({ error: 'Falha ao preparar a conta. Tente novamente em alguns instantes.' });
  }

  console.log(`[api/partner-signup] OK | uid=${userId} | INERTE | terms=${TERMS_VERSION} | privacy=${PRIVACY_VERSION} | ip=${ip}`);

  // ── 6. Sucesso ──────────────────────────────────────────────────────────────
  return res.status(200).json({
    ok: true,
    message: 'Tudo certo, sua conta foi criada! Agora confirme seu e-mail e é só aguardar — eu libero seu acesso na mão e te aviso assim que estiver pronto.',
  });
}
