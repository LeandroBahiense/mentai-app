/**
 * Pallyum — Cancelar assinatura recorrente Asaas
 *
 * Recebe POST autenticado (cookie HMAC). Lê asaas_subscription_id do user,
 * chama DELETE /v3/subscriptions/{id} na Asaas (que remove cobranças futuras),
 * e marca subscription_canceled_at = NOW() no Supabase.
 *
 * Política: usuário mantém acesso ao plano até plano_validade já paga.
 * Nada de prorate, nada de reembolso.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { cancelAllAddOns, mirrorPlanCluster } from '../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_API_KEY             = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function toBase64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readSession(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)pallyum_session=([^;]+)/);
  if (!match) return null;
  const cookieVal = match[1];
  const dot = cookieVal.lastIndexOf('.');
  if (dot === -1) return null;
  const payloadB64  = cookieVal.slice(0, dot);
  const sigReceived = cookieVal.slice(dot + 1);
  const expectedSig = toBase64url(createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest());
  try {
    const a = Buffer.from(sigReceived);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.uid || typeof payload.uid !== 'string') return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload.uid;
}

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) {
    return res.status(401).json({ error: 'sessão inválida' });
  }

  // 1. Buscar dados da assinatura: subscription_id vem de subscriptions,
  //    plano_validade e subscription_canceled_at continuam em user_preferences
  let subscriptionId = null;
  let planoValidade  = null;
  try {
    const [prefsRes, subRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&select=plano_validade,subscription_canceled_at`,
        { headers: svcHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=asaas_subscription_id`,
        { headers: svcHeaders() }
      ),
    ]);

    const prefsRows = await prefsRes.json();
    if (!Array.isArray(prefsRows) || prefsRows.length === 0) {
      return res.status(404).json({ error: 'Preferências de usuário não encontradas' });
    }
    if (prefsRows[0].subscription_canceled_at) {
      return res.status(400).json({ error: 'Assinatura já cancelada anteriormente' });
    }
    planoValidade = prefsRows[0].plano_validade;

    const subRows = await subRes.json();
    subscriptionId = subRows?.[0]?.asaas_subscription_id || null;
  } catch (e) {
    console.error('[cancel-subscription] erro lendo Supabase:', e.message);
    return res.status(500).json({ error: 'Erro ao consultar dados da assinatura' });
  }

  if (!subscriptionId) {
    return res.status(400).json({ error: 'Nenhuma assinatura ativa encontrada para cancelar' });
  }

  // 2. Chamar Asaas DELETE /v3/subscriptions/{id}
  try {
    const delRes = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method:  'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY,
      },
    });
    const delData = await delRes.json().catch(() => ({}));

    if (!delRes.ok && delRes.status !== 404) {
      // 404 = subscription já não existe na Asaas (pode ter sido cancelada antes); tratamos como sucesso idempotente
      console.error(`[cancel-subscription] Asaas DELETE falhou | status=${delRes.status} | body=${JSON.stringify(delData)}`);
      return res.status(502).json({ error: 'Falha ao cancelar na Asaas: ' + JSON.stringify(delData) });
    }
  } catch (e) {
    console.error('[cancel-subscription] erro chamando Asaas:', e.message);
    return res.status(502).json({ error: 'Erro de comunicação com Asaas' });
  }

  // Cascata (Etapa 04.4a): plano cancelado → cancela os add-ons (e-mails extras),
  // senão seguem cobrando sozinhos. Best-effort: não bloqueia o cancelamento.
  await cancelAllAddOns(uid);

  // 3. Marcar como cancelado no Supabase (duas tabelas, em paralelo)
  try {
    const now = new Date().toISOString();
    const [patchPrefsRes, patchSubRes] = await Promise.all([
      // user_preferences: marca cancelamento (subscription_canceled_at)
      fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}`,
        {
          method:  'PATCH',
          headers: svcHeaders(),
          body: JSON.stringify({ subscription_canceled_at: now, updated_at: now }),
        }
      ),
      // subscriptions: zera asaas_subscription_id (não há mais assinatura ativa)
      fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}`,
        {
          method:  'PATCH',
          headers: svcHeaders(),
          body: JSON.stringify({ asaas_subscription_id: null, updated_at: now }),
        }
      ),
    ]);

    if (!patchPrefsRes.ok) {
      const err = await patchPrefsRes.text();
      console.error('[cancel-subscription] PATCH user_preferences falhou:', err);
      console.error(`[cancel-subscription] CRÍTICO: Asaas cancelou subscription=${subscriptionId} mas Supabase falhou. uid=${uid}`);
      return res.status(500).json({ error: 'Cancelamento parcial — entre em contato com suporte' });
    }

    // Dual-write (04.5/F2): espelha o cancelamento em subscriptions (aditivo, best-effort).
    await mirrorPlanCluster(uid, { subscription_canceled_at: now });

    if (!patchSubRes.ok) {
      // Não crítico: Asaas cancelou e prefs foi atualizado; apenas loga para reconciliação
      const err = await patchSubRes.text();
      console.error('[cancel-subscription] PATCH subscriptions falhou (não crítico):', err);
    }
  } catch (e) {
    console.error('[cancel-subscription] erro atualizando Supabase:', e.message);
    return res.status(500).json({ error: 'Cancelamento parcial — entre em contato com suporte' });
  }

  console.log(`[cancel-subscription] OK | uid=${uid} | subscription=${subscriptionId}`);

  return res.status(200).json({
    ok: true,
    message: 'Assinatura cancelada com sucesso',
    accessUntil: planoValidade,
  });
}
