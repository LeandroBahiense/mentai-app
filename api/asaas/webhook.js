/**
 * Pallyum — Webhook Asaas
 * Fonte primária : payment.externalReference = "userId|sku"
 * Fallback       : parsePlanFromDescription(payment.description)
 * Atualiza user_preferences.plano + plano_validade; grava asaas_customer_id +
 * asaas_subscription_id em subscriptions (tabela dedicada, não em user_preferences)
 *
 * Validação do token é fail-closed: se ASAAS_WEBHOOK_TOKEN não estiver
 * configurada, todas as requisições são recusadas com 500.
 */

import { timingSafeEqual } from 'crypto';
import { sendPlanoAtivadoByUserId, sendPlanoAtivadoByCustomerId } from '../_lib/email.js';

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try { return timingSafeEqual(bufA, bufB); } catch { return false; }
}

// ── Parser primário: externalReference = "userId|sku" ─────────────────────────
// Ex: "abc123|companion-pro-mensal"  →  { plano: 'companion-pro', meses: 1 }
//     "abc123|segundo-cerebro-ultra-anual" → { plano: 'segundo-cerebro-ultra', meses: 12 }

function parsePlanFromSku(sku) {
  if (!sku) return null;

  const isAnual = sku.endsWith('-anual');
  const isMensal = sku.endsWith('-mensal');
  if (!isAnual && !isMensal) return null;

  const meses = isAnual ? 12 : 1;
  const plano = isAnual ? sku.slice(0, -6) : sku.slice(0, -7); // remove '-anual' ou '-mensal'

  const PLANOS_VALIDOS = [
    'companion-essencial', 'companion-pro', 'companion-ultra',
    'segundo-cerebro-essencial', 'segundo-cerebro-pro', 'segundo-cerebro-ultra',
    'coletivo-team', 'coletivo-business', 'coletivo-enterprise',
    'duo-essencial', 'duo-pro', 'duo-ultra',
    // Novo catálogo Pallyum (01/06/2026)
    'essencial', 'pro', 'ultra',
  ];
  if (!PLANOS_VALIDOS.includes(plano)) {
    console.warn(`ASAAS WEBHOOK: plano "${plano}" não reconhecido (sku=${sku})`);
    return null;
  }

  return { plano, meses };
}

// ── Parser fallback: description = "Pallyum {Label} — {Período}" ──────────────
function parsePlanFromDescription(description) {
  const desc = (description || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const meses = desc.includes('anual') ? 12 : 1;

  let produto = null;
  if (desc.includes('segundo cerebro') || desc.includes('segundo-cerebro')) {
    produto = 'segundo-cerebro';
  } else if (desc.includes('coletivo')) {
    produto = 'coletivo';
  } else if (desc.includes('duo')) {
    produto = 'duo';
  } else if (desc.includes('companion')) {
    produto = 'companion';
  }

  let tier = null;
  if (desc.includes('business'))                                   tier = 'business';
  else if (desc.includes('enterprise'))                            tier = 'enterprise';
  else if (desc.includes('ultra'))                                 tier = 'ultra';
  else if (desc.includes('pro'))                                   tier = 'pro';
  else if (desc.includes('team'))                                  tier = 'team';
  else if (desc.includes('essencial') || desc.includes('essential')) tier = 'essencial';

  // Novo catálogo Pallyum (sem prefixo de produto): plano = tier
  if (!produto && (tier === 'essencial' || tier === 'pro' || tier === 'ultra')) {
    return { plano: tier, meses };
  }

  if (!produto || !tier) {
    console.warn(`ASAAS WEBHOOK: não foi possível parsear "${description}" | produto=${produto} tier=${tier}`);
    return null;
  }

  const plano = `${produto}-${tier}`;

  const PLANOS_VALIDOS = [
    'companion-essencial', 'companion-pro', 'companion-ultra',
    'segundo-cerebro-essencial', 'segundo-cerebro-pro', 'segundo-cerebro-ultra',
    'coletivo-team', 'coletivo-business', 'coletivo-enterprise',
    'duo-essencial', 'duo-pro', 'duo-ultra',
  ];
  if (!PLANOS_VALIDOS.includes(plano)) {
    console.warn(`ASAAS WEBHOOK: plano "${plano}" não reconhecido`);
    return null;
  }

  return { plano, meses };
}

// ── Atualiza plano por userId (fonte primária) ─────────────────────────────────
async function updateUserPlanByUserId(userId, plano, meses, subscriptionId, customerId) {
  const validade = new Date();
  validade.setMonth(validade.getMonth() + meses);

  // Plano e validade ficam em user_preferences (não mudou)
  const patchBody = {
    plano,
    plano_validade:           validade.toISOString(),
    subscription_canceled_at: null, // nova cobrança = reativação
    updated_at:               new Date().toISOString(),
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: svcHeaders(), body: JSON.stringify(patchBody) }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase PATCH user_preferences falhou: ' + err);
  }

  // Grava asaas_customer_id + asaas_subscription_id em subscriptions.
  // ?on_conflict=user_id mira a constraint UNIQUE simples — sem isso o PostgREST
  // usaria a PK (uuid gerado) e criaria linhas duplicadas a cada webhook.
  const subBody = {
    user_id:    userId,
    updated_at: new Date().toISOString(),
  };
  if (customerId)     subBody.asaas_customer_id     = customerId;
  if (subscriptionId) subBody.asaas_subscription_id = subscriptionId;

  if (customerId || subscriptionId) {
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`,
      {
        method:  'POST',
        headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(subBody),
      }
    );
    if (!subRes.ok) {
      const err = await subRes.text();
      // Não bloqueia o 200 — plan já foi atualizado; loga para reconciliação
      console.error('[webhook] upsert subscriptions falhou (não crítico):', err);
    }
  }

  return validade.toISOString();
}

// ── Atualiza plano por asaas_customer_id (fallback para pagamentos antigos) ────
async function updateUserPlanByCustomer(customerId, plano, meses, subscriptionId) {
  const validade = new Date();
  validade.setMonth(validade.getMonth() + meses);

  // 1. Resolve user_id a partir de subscriptions (migrado de user_preferences)
  const lookupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?asaas_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id`,
    { headers: svcHeaders() }
  );
  if (!lookupRes.ok) {
    const err = await lookupRes.text();
    throw new Error('Supabase lookup subscriptions falhou: ' + err);
  }
  const lookupRows = await lookupRes.json();
  const userId = lookupRows?.[0]?.user_id;
  if (!userId) {
    throw new Error('customer_id não encontrado em subscriptions: ' + customerId);
  }

  // 2. Atualiza plano em user_preferences por user_id
  const patchBody = {
    plano,
    plano_validade:           validade.toISOString(),
    subscription_canceled_at: null,
    updated_at:               new Date().toISOString(),
  };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: svcHeaders(), body: JSON.stringify(patchBody) }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase PATCH user_preferences falhou: ' + err);
  }

  // 3. Grava asaas_customer_id + asaas_subscription_id em subscriptions.
  //    Chaves omitidas quando falsy — merge-duplicates do PostgREST preserva
  //    o valor já gravado se a chave não estiver no JSON (nunca apaga com null).
  {
    const subBody = {
      user_id:    userId,
      updated_at: new Date().toISOString(),
    };
    if (customerId)     subBody.asaas_customer_id     = customerId;
    if (subscriptionId) subBody.asaas_subscription_id = subscriptionId;

    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`,
      {
        method:  'POST',
        headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(subBody),
      }
    );
    if (!subRes.ok) {
      const err = await subRes.text();
      console.error('[webhook] upsert subscriptions (fallback) falhou (não crítico):', err);
    }
  }

  return validade.toISOString();
}

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!ASAAS_WEBHOOK_TOKEN) {
    console.error('ASAAS WEBHOOK: ASAAS_WEBHOOK_TOKEN não configurada — recusando todas as requisições');
    return res.status(500).json({ error: 'Webhook misconfigured' });
  }

  const token = req.headers['asaas-access-token'];
  if (!token || !safeEqual(token, ASAAS_WEBHOOK_TOKEN)) {
    console.warn('ASAAS WEBHOOK: token ausente ou inválido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;
  console.log(`ASAAS WEBHOOK: event=${event?.event} | payment=${event?.payment?.id}`);

  const PAYMENT_EVENTS = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
  if (!PAYMENT_EVENTS.includes(event?.event)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const payment = event.payment;
  if (!payment) {
    console.error('ASAAS WEBHOOK: payload sem payment');
    return res.status(400).json({ error: 'Payload inválido' });
  }

  const externalRef  = (payment.externalReference || '').trim();
  const customerId   = payment.customer;
  const description  = payment.description || '';

  try {
    // ── Fonte primária: externalReference = "userId|sku" ──────────────────────
    const refParts  = externalRef.split('|');
    const refUserId = (refParts[0] || '').trim();
    const refSku    = (refParts[1] || '').trim();

    if (refUserId && refSku) {
      const parsed = parsePlanFromSku(refSku);

      if (parsed) {
        const { plano, meses } = parsed;
        const subscriptionId = payment.subscription || null;
        const validade = await updateUserPlanByUserId(refUserId, plano, meses, subscriptionId, customerId);
        // Dispara email transacional. Não-bloqueante — webhook ainda responde 200 mesmo se Resend falhar.
        try {
          await sendPlanoAtivadoByUserId({
            userId:        refUserId,
            planoSlug:     plano,
            planoValidade: validade,
            valor:         payment.value,
          });
          console.log('[webhook] email "plano ativado" enviado | userId=' + refUserId);
        } catch (emailErr) {
          console.error('[webhook] falha ao enviar email para userId=' + refUserId + ':', emailErr.message);
        }
        console.log(`ASAAS WEBHOOK: [externalRef] plano atualizado | userId=${refUserId} | plano=${plano} | meses=${meses} | validade=${validade}`);
        return res.status(200).json({ ok: true, source: 'externalReference', plano, meses, validade });
      }

      console.warn(`ASAAS WEBHOOK: externalReference presente mas sku inválido: "${refSku}" — tentando fallback`);
    }

    // ── Fallback: description + asaas_customer_id (pagamentos antigos) ────────
    if (!customerId) {
      console.error('ASAAS WEBHOOK: sem customer id e sem externalReference válido');
      return res.status(400).json({ error: 'Não foi possível identificar o usuário' });
    }

    const parsed = parsePlanFromDescription(description);

    if (!parsed) {
      console.error(`ASAAS WEBHOOK: não parseable: description="${description}" | externalRef="${externalRef}"`);
      return res.status(200).json({ ok: false, reason: 'not_parseable', description, externalRef });
    }

    const { plano, meses } = parsed;
    const subscriptionId = payment.subscription || null;
    const validade = await updateUserPlanByCustomer(customerId, plano, meses, subscriptionId);
    try {
      await sendPlanoAtivadoByCustomerId({
        customerId:    customerId,
        planoSlug:     plano,
        planoValidade: validade,
        valor:         payment.value,
      });
      console.log('[webhook] email "plano ativado" enviado | customerId=' + customerId);
    } catch (emailErr) {
      console.error('[webhook] falha ao enviar email para customerId=' + customerId + ':', emailErr.message);
    }
    console.log(`ASAAS WEBHOOK: [description fallback] plano atualizado | customer=${customerId} | plano=${plano} | meses=${meses} | validade=${validade}`);
    return res.status(200).json({ ok: true, source: 'description_fallback', plano, meses, validade });

  } catch (err) {
    console.error('ASAAS WEBHOOK ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
