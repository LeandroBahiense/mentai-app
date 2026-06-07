/**
 * Pallyum — Preview de troca de plano (Bloco C, Parte 1/4)
 *
 * POST /api/asaas/plan-change-preview   body: { targetPlano: "pro" }
 *
 * READ-ONLY. NÃO altera assinatura, NÃO cobra nada. Só:
 *   - resolve o user logado (cookie pallyum_session, mesmo esquema do checkout),
 *   - lê plano atual (user_preferences) + asaas_subscription_id (subscriptions),
 *   - GET /subscriptions/{id} no Asaas para pegar o nextDueDate,
 *   - classifica (upgrade/downgrade/same) e calcula a diferença pró-rata.
 *
 * Resposta:
 *   { direction, currentPlano, targetPlano, priceTarget, nextDueDate,
 *     difference, chargeWaived }
 *
 * Sem asaas_subscription_id → 400 (não é pagante ativo: não há o que trocar).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { SKUS, classifyPlanChange, prorationDiff } from '../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

// ── Helpers de sessão — CÓPIA LITERAL de api/asaas/checkout.js ───────────────

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

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const targetPlano = (req.body?.targetPlano || '').trim();
  if (!targetPlano) {
    return res.status(400).json({ error: 'Campo obrigatório: targetPlano' });
  }

  try {
    // 1. Plano atual (user_preferences) + asaas_subscription_id (subscriptions).
    const [prefRes, subRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&select=plano&limit=1`,
        { headers: svcHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=asaas_subscription_id&limit=1`,
        { headers: svcHeaders() }
      ),
    ]);

    if (!prefRes.ok || !subRes.ok) {
      console.error('[plan-change-preview] query Supabase falhou:', prefRes.status, subRes.status);
      return res.status(500).json({ error: 'Falha ao consultar dados do plano' });
    }

    const prefRows = await prefRes.json();
    const subRows  = await subRes.json();

    const currentPlano    = prefRows?.[0]?.plano || null;
    const subscriptionId  = subRows?.[0]?.asaas_subscription_id || null;

    // 2. Sem assinatura Asaas viva → não é pagante ativo, não há troca a prever.
    if (!subscriptionId) {
      return res.status(400).json({
        error: 'Você não tem uma assinatura ativa para trocar de plano.',
        code:  'no_active_subscription',
      });
    }

    if (!currentPlano) {
      return res.status(400).json({
        error: 'Não foi possível identificar seu plano atual.',
        code:  'no_current_plan',
      });
    }

    // 3. Classifica a transição (preços vêm de SKUS — fonte única).
    const direction = classifyPlanChange(currentPlano, targetPlano);
    if (direction === null) {
      return res.status(400).json({
        error: `Plano não suportado para troca (atual="${currentPlano}", alvo="${targetPlano}").`,
        code:  'unsupported_plan',
      });
    }

    // 4. GET assinatura no Asaas → nextDueDate (mesmo padrão do webhook).
    let nextDueDate = null;
    try {
      const asaasRes = await fetch(
        `${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY } }
      );
      if (asaasRes.ok) {
        const subData = await asaasRes.json();
        nextDueDate = subData?.nextDueDate || null;
      } else {
        console.error('[plan-change-preview] GET subscription Asaas retornou', asaasRes.status);
      }
    } catch (e) {
      console.error('[plan-change-preview] GET subscription Asaas erro:', e.message);
    }

    if (!nextDueDate) {
      return res.status(502).json({
        error: 'Não foi possível obter a data da próxima cobrança junto à Asaas.',
        code:  'asaas_unavailable',
      });
    }

    // 5. Proration (só relevante p/ upgrade; o cliente ignora em downgrade/same).
    const prorated   = prorationDiff({ currentPlano, targetPlano, nextDueDate });
    const priceTarget = SKUS[`${targetPlano}-mensal`]?.value ?? null;

    return res.status(200).json({
      direction,                                   // 'same' | 'upgrade' | 'downgrade'
      currentPlano,
      targetPlano,
      priceTarget,
      nextDueDate,
      difference:  prorated ? prorated.diff : 0,
      chargeWaived: prorated ? prorated.chargeWaived : false,
    });

  } catch (e) {
    console.error('[plan-change-preview] erro inesperado:', e.message);
    return res.status(500).json({ error: 'Erro inesperado ao calcular o preview' });
  }
}
