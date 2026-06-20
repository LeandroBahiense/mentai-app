/**
 * Pallyum — Troca de plano (Bloco C, Parte 2/4) — MOVE DINHEIRO.
 *
 * POST /api/asaas/plan-change   body: { targetPlano: "pro" }
 *
 * Decide por preço (SKUS — fonte única em _lib/plans.js):
 *   targetPrice > effectivePrice → UPGRADE   (cobra a diferença pró-rata HOJE,
 *                                              repreca a assinatura, entrega o plano)
 *   targetPrice < effectivePrice → DOWNGRADE (só agenda: repreca a assinatura p/
 *                                              o próximo ciclo; não cobra, não troca já)
 *   igual + scheduledPlano≠target → UNDO     (reverte um downgrade agendado)
 *   igual + scheduledPlano=target → NOOP
 *
 * Ordem de segurança de dinheiro (UPGRADE com cobrança):
 *   1) cobrar diferença  2) repreçar assinatura  3) PATCH banco (entrega o plano)
 *   - Cobrança falha            → aborta limpo (402), nada muda.
 *   - Cobrança OK mas passo 2/3 → NÃO engole: loga estado completo, PRIORIZA
 *     entregar o plano (faz o PATCH) e retorna 500 plan_change_partial p/ reconciliação.
 *
 * Auth: cookie pallyum_session (cópia literal do checkout). Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { SKUS, prorationDiff, parsePlanFromSku, dataHojeSP, downgradeCapacityCheck, mirrorPlanCluster } from '../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

// Marker da cobrança avulsa da diferença — o webhook ignora (não vira plano).
const DIFF_MARKER_SKU = 'plan_upgrade_diff';

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

function asaasHeaders() {
  return { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY };
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

// ── Captura de IP — CÓPIA LITERAL de api/signup.js (getClientIp) ─────────────
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || null;
}

// ── POST /subscriptions/{id} (repreçar value/externalReference) ──────────────
async function updateAsaasSubscription(subscriptionId, body) {
  const r = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method:  'POST',
    headers: asaasHeaders(),
    body:    JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
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
    return res.status(400).json({ error: 'Campo obrigatório: targetPlano', code: 'missing_target' });
  }

  // Preço alvo (fonte única SKUS). Inválido → 400.
  const targetSku = SKUS[`${targetPlano}-mensal`];
  if (!targetSku) {
    return res.status(400).json({ error: `Plano inválido: "${targetPlano}".`, code: 'unsupported_plan' });
  }
  const targetPrice = targetSku.value;

  try {
    // 1. effectivePlano (user_preferences) + asaas_subscription_id/customer_id (subscriptions)
    const [prefRes, subRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=plano,is_trial&limit=1`,
        { headers: svcHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=asaas_subscription_id,asaas_customer_id&limit=1`,
        { headers: svcHeaders() }
      ),
    ]);

    if (!prefRes.ok || !subRes.ok) {
      console.error('[plan-change] query Supabase falhou:', prefRes.status, subRes.status);
      return res.status(500).json({ error: 'Falha ao consultar dados do plano' });
    }

    const prefRows = await prefRes.json();
    const subRows  = await subRes.json();

    const effectivePlano = prefRows?.[0]?.plano || null;
    const isTrial        = prefRows?.[0]?.is_trial === true;
    const subscriptionId = subRows?.[0]?.asaas_subscription_id || null;
    const customerId     = subRows?.[0]?.asaas_customer_id || null;

    // Guard de trial (Bloco B no servidor): um usuário em teste TEM asaas_subscription_id
    // (Bloco A), então sem esta trava uma chamada direta ao endpoint — fora da UI —
    // converteria o trial em pagante e cobraria a diferença no meio do teste.
    // BLOQUEIA antes de qualquer chamada ao Asaas ou alteração. A trava de UI não basta.
    if (isTrial) {
      return res.status(409).json({
        error: 'Você está no teste grátis. Não é possível trocar de plano durante o teste — aguarde o fim do período.',
        code:  'trial_cannot_change',
      });
    }

    if (!subscriptionId) {
      return res.status(400).json({
        error: 'Você não tem uma assinatura ativa para trocar de plano.',
        code:  'no_active_subscription',
      });
    }

    const effectiveSku = effectivePlano ? SKUS[`${effectivePlano}-mensal`] : null;
    if (!effectiveSku) {
      return res.status(400).json({
        error: `Seu plano atual ("${effectivePlano}") não é suportado para troca por aqui.`,
        code:  'unsupported_plan',
      });
    }
    const effectivePrice = effectiveSku.value;

    // 2. GET assinatura no Asaas → value, externalReference, nextDueDate, token de cartão.
    let subData = null;
    try {
      const getR = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        headers: asaasHeaders(),
      });
      if (getR.ok) subData = await getR.json();
      else console.error('[plan-change] GET subscription Asaas retornou', getR.status);
    } catch (e) {
      console.error('[plan-change] GET subscription Asaas erro:', e.message);
    }
    if (!subData) {
      return res.status(502).json({ error: 'Não foi possível consultar a assinatura na Asaas.', code: 'asaas_unavailable' });
    }

    const nextDueDate     = subData.nextDueDate || null;
    const creditCardToken = subData?.creditCard?.creditCardToken || null;
    const scheduledSku    = (subData.externalReference || '').split('|')[1] || '';
    const scheduledPlano  = parsePlanFromSku(scheduledSku)?.plano || null;

    if (!nextDueDate) {
      return res.status(502).json({ error: 'Assinatura sem próxima cobrança definida na Asaas.', code: 'asaas_unavailable' });
    }

    // 3. Decisão por preço.
    // ── DOWNGRADE: só agenda (repreca p/ o próximo ciclo). Não cobra, não troca já.
    if (targetPrice < effectivePrice) {
      // Bloqueio por excedente (Etapa 04.4c, regra b): se as contas conectadas não cabem
      // no tier de destino, o usuário desconecta o que quiser antes de fazer o downgrade.
      const cap = await downgradeCapacityCheck(uid, targetPlano);
      if (!cap.ok) {
        return res.status(409).json({
          error: `Você tem ${cap.used} conta(s) conectada(s), mas o plano ${targetPlano} comporta ${cap.capacity}. Desconecte ${cap.excedente} conta(s) antes de fazer o downgrade.`,
          code:  'downgrade_excede_capacidade',
          used:  cap.used, capacity: cap.capacity, excedente: cap.excedente,
        });
      }
      const up = await updateAsaasSubscription(subscriptionId, {
        value:             targetPrice,
        externalReference: `${uid}|${targetPlano}-mensal`,
      });
      if (!up.ok) {
        console.error('[plan-change][downgrade] Asaas update falhou:', up.status, JSON.stringify(up.data));
        return res.status(502).json({ error: 'Falha ao agendar o downgrade na Asaas.', code: 'asaas_update_failed' });
      }
      console.log(`[plan-change] DOWNGRADE agendado | uid=${uid} | ${effectivePlano}→${targetPlano} | efetivo em ${nextDueDate}`);
      return res.status(200).json({
        result:        'downgrade',
        plano_atual:   effectivePlano,
        plano_agendado: targetPlano,
        effectiveDate: nextDueDate,
      });
    }

    // ── igual: UNDO (reverter downgrade agendado) ou NOOP.
    if (targetPrice === effectivePrice) {
      if (scheduledPlano && scheduledPlano !== targetPlano) {
        const up = await updateAsaasSubscription(subscriptionId, {
          value:             effectivePrice,
          externalReference: `${uid}|${effectivePlano}-mensal`,
        });
        if (!up.ok) {
          console.error('[plan-change][undo] Asaas update falhou:', up.status, JSON.stringify(up.data));
          return res.status(502).json({ error: 'Falha ao reverter o downgrade na Asaas.', code: 'asaas_update_failed' });
        }
        console.log(`[plan-change] UNDO downgrade | uid=${uid} | volta para ${effectivePlano}`);
        return res.status(200).json({ result: 'undo', plano: effectivePlano });
      }
      console.log(`[plan-change] NOOP | uid=${uid} | plano=${effectivePlano}`);
      return res.status(200).json({ result: 'noop' });
    }

    // ── UPGRADE (targetPrice > effectivePrice): cobra diferença → repreca → entrega.
    const { diff, chargeWaived } = prorationDiff({ currentPlano: effectivePlano, targetPlano, nextDueDate });

    // (1) cobrar a diferença, se houver e não for irrisória.
    if (diff > 0 && !chargeWaived) {
      if (!creditCardToken) {
        return res.status(409).json({
          error: 'Não há cartão salvo na sua assinatura para cobrar a diferença do upgrade.',
          code:  'no_card_token',
        });
      }
      let payData = {};
      try {
        const payR = await fetch(`${ASAAS_BASE_URL}/payments`, {
          method:  'POST',
          headers: asaasHeaders(),
          body: JSON.stringify({
            customer:          customerId,
            billingType:       'CREDIT_CARD',
            value:             diff,
            dueDate:           dataHojeSP(),
            creditCardToken:   creditCardToken,
            externalReference: `${uid}|${DIFF_MARKER_SKU}`,
            remoteIp:          getClientIp(req),
          }),
        });
        payData = await payR.json().catch(() => ({}));
      } catch (e) {
        console.error('[plan-change][upgrade] POST /payments erro:', e.message);
        return res.status(402).json({ error: 'Falha ao cobrar a diferença do upgrade.', code: 'charge_failed' });
      }
      if (!['CONFIRMED', 'RECEIVED'].includes(payData.status)) {
        console.error(`[plan-change][upgrade] cobrança não capturada | uid=${uid} | status=${payData.status} | body=${JSON.stringify(payData)}`);
        return res.status(402).json({ error: 'A cobrança da diferença não foi aprovada.', code: 'charge_failed' });
      }
      console.log(`[plan-change][upgrade] diferença cobrada | uid=${uid} | value=${diff} | payment=${payData.id} | status=${payData.status}`);
    }

    // A partir daqui: ou nada foi cobrado (waived/diff=0) ou a cobrança PASSOU.
    // Money-safety: não engolir falhas dos passos seguintes — entregar o plano.
    const charged = chargeWaived ? 0 : diff;

    // (2) repreçar a assinatura (afeta só o futuro).
    let subUpdateErr = null;
    try {
      const up = await updateAsaasSubscription(subscriptionId, {
        value:             targetPrice,
        externalReference: `${uid}|${targetPlano}-mensal`,
      });
      if (!up.ok) subUpdateErr = `status=${up.status} body=${JSON.stringify(up.data)}`;
    } catch (e) {
      subUpdateErr = e.message;
    }

    // (3) PATCH user_preferences — entrega o plano. NÃO toca plano_validade.
    let patchErr = null;
    try {
      const patchR = await fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}`,
        {
          method:  'PATCH',
          headers: svcHeaders(),
          body: JSON.stringify({ plano: targetPlano, is_trial: false, updated_at: new Date().toISOString() }),
        }
      );
      if (!patchR.ok) patchErr = await patchR.text();
    } catch (e) {
      patchErr = e.message;
    }

    // Dual-write (04.5/F2): espelha o cluster em subscriptions só se o PATCH primário deu certo.
    if (!patchErr) await mirrorPlanCluster(uid, { plano: targetPlano, is_trial: false });

    if (subUpdateErr || patchErr) {
      // Cliente pode já ter pago. Estado completo logado para reconciliação manual.
      console.error('[plan-change][upgrade] PARCIAL — cobrança feita mas passo seguinte falhou:',
        JSON.stringify({ uid, subscriptionId, effectivePlano, targetPlano, charged, chargeWaived, subUpdateErr, patchErr }));
      return res.status(500).json({
        error:        'Upgrade parcial — sua cobrança pode ter sido feita; nosso time vai reconciliar.',
        code:         'plan_change_partial',
        charged,
        chargeWaived,
      });
    }

    console.log(`[plan-change] UPGRADE OK | uid=${uid} | ${effectivePlano}→${targetPlano} | charged=${charged} | waived=${chargeWaived}`);
    return res.status(200).json({
      result:       'upgrade',
      plano:        targetPlano,
      charged,
      chargeWaived,
    });

  } catch (e) {
    console.error('[plan-change] erro inesperado:', e.message);
    return res.status(500).json({ error: 'Erro inesperado na troca de plano' });
  }
}
