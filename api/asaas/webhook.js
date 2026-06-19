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
import { parsePlanFromSku, mirrorPlanCluster } from '../_lib/plans.js';

// Marker de cobrança avulsa da diferença de upgrade (Bloco C). NÃO é evento de
// plano — é receita pontual. O webhook ignora (não toca plano/validade).
const DIFF_MARKER_SKU = 'plan_upgrade_diff';
// Marker do add-on de e-mail avulso (+R$15/mês, 03.4b) — receita recorrente do
// add-on, NÃO evento de plano. O webhook ignora igual ao DIFF_MARKER_SKU.
const ADDON_MARKER_SKU = 'email_extra';

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;
const ASAAS_API_KEY       = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL      = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

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

// parsePlanFromSku foi movido para ../_lib/plans.js (fonte única) — importado acima.

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

// Helper: "hoje SP + N dias" → ISO string (para fallback do dueDate)
function dataSPplusDias(dias) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date(Date.now() + dias * 86400000));
}

// ── Trial-grant: concede acesso imediato ao tier na CRIAÇÃO da assinatura ────────
// Só age se o usuário estiver inativo (plano nulo/gratuito/teste OU validade expirada).
// Se já tiver plano válido no futuro, ignora — impede que renovações sobrescrevam.
async function grantTrialIfInactive(userId, plano, dueDate, customerId, subscriptionId) {
  // 1. Lê estado atual do plano
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(userId)}&select=plano,plano_validade`,
    { headers: svcHeaders() }
  );
  const rows = checkRes.ok ? await checkRes.json() : [];
  const current = Array.isArray(rows) ? rows[0] : null;

  const planoAtual    = current?.plano || null;
  const validadeAtual = current?.plano_validade || null;

  const inativo = !planoAtual
    || planoAtual === 'gratuito'
    || planoAtual === 'companion-teste'
    || !validadeAtual
    || new Date(validadeAtual).getTime() <= Date.now();

  if (!inativo) {
    console.log(`ASAAS WEBHOOK trial-grant IGNORADO (plano já ativo): userId=${userId} plano=${planoAtual} validade=${validadeAtual}`);
    return;
  }

  // 2. plano_validade = dueDate do Asaas (= D+7) ou fallback hoje SP + 7 dias
  let planoValidade;
  if (dueDate && /^\d{4}-\d{2}-\d{2}/.test(dueDate)) {
    // dueDate vem como "YYYY-MM-DD" do Asaas; converter para ISO fim-do-dia SP
    planoValidade = dueDate + 'T23:59:59-03:00';
  } else {
    planoValidade = dataSPplusDias(7) + 'T23:59:59-03:00';
  }

  // 3. PATCH em user_preferences — CAMINHO DEDICADO (não usa updateUserPlanByUserId,
  //    que calcula now + meses e é exclusivo para PAYMENT_CONFIRMED)
  const patchBody = {
    plano,
    plano_validade:           planoValidade,
    subscription_canceled_at: null,
    is_trial:                 true,
    updated_at:               new Date().toISOString(),
  };
  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: svcHeaders(), body: JSON.stringify(patchBody) }
  );
  if (!patchRes.ok) {
    throw new Error('PATCH user_preferences falhou: ' + await patchRes.text());
  }

  // Dual-write (04.5/F2): espelha o cluster de plano em subscriptions (aditivo, best-effort).
  await mirrorPlanCluster(userId, { plano, plano_validade: planoValidade, subscription_canceled_at: null, is_trial: true });

  // Persiste os ids do Asaas em subscriptions — MESMO padrão do PAYMENT_CONFIRMED.
  // Destrava o botão "Cancelar assinatura" durante o trial. Campos só entram no body
  // se truthy → null nunca sobrescreve id já salvo. NÃO toca no cluster de plano (Etapa 04).
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
      // Não bloqueia — o plano já foi concedido; loga para reconciliação
      console.error('[webhook] trial-grant upsert subscriptions falhou (não crítico):', err);
    }
  }

  console.log(`ASAAS WEBHOOK trial-grant OK | userId=${userId} | plano=${plano} | plano_validade=${planoValidade}`);
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
    is_trial:                 false,
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

  // Dual-write (04.5/F2): espelha o cluster de plano em subscriptions (aditivo, best-effort).
  await mirrorPlanCluster(userId, { plano, plano_validade: validade.toISOString(), subscription_canceled_at: null, is_trial: false });

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
    is_trial:                 false,
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

  // Dual-write (04.5/F2): espelha o cluster de plano em subscriptions (aditivo, best-effort).
  await mirrorPlanCluster(userId, { plano, plano_validade: validade.toISOString(), subscription_canceled_at: null, is_trial: false });

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

// ── Resolvedor único de {refUserId, refSku} a partir de um evento de pagamento ──
// Ordem: (1) payment.externalReference; (2) GET na assinatura → externalReference;
// (2b) GET na assinatura → checkoutSession → SELECT em checkout_sessions; (3) null.
async function resolveUserAndSku(payment) {
  // 1) externalReference do próprio payment
  const direct = (payment.externalReference || '').trim();
  if (direct) {
    const [u, s] = direct.split('|');
    const refUserId = (u || '').trim();
    const refSku    = (s || '').trim();
    if (refUserId && refSku) {
      return { refUserId, refSku, source: 'payment.externalReference' };
    }
  }

  // 2) precisa da assinatura
  const subscriptionId = payment.subscription || null;
  if (!subscriptionId) {
    console.warn('ASAAS WEBHOOK resolve: sem externalReference e sem subscription');
    return null;
  }

  let subData = null;
  try {
    const subRes = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
    });
    if (subRes.ok) {
      subData = await subRes.json();
    } else {
      console.warn(`ASAAS WEBHOOK resolve: GET subscription ${subscriptionId} retornou ${subRes.status}`);
    }
  } catch (e) {
    console.warn(`ASAAS WEBHOOK resolve: falha ao buscar subscription ${subscriptionId}:`, e.message);
  }

  if (subData) {
    // 2a) externalReference da assinatura
    const subRef = (subData.externalReference || '').trim();
    if (subRef) {
      const [u, s] = subRef.split('|');
      const refUserId = (u || '').trim();
      const refSku    = (s || '').trim();
      if (refUserId && refSku) {
        console.log(`ASAAS WEBHOOK resolve: via subscription.externalReference (${subscriptionId})`);
        return { refUserId, refSku, source: 'subscription.externalReference' };
      }
    }

    // 2b) checkoutSession da assinatura → tabela checkout_sessions
    const checkoutSessionId = (subData.checkoutSession || '').trim();
    if (checkoutSessionId) {
      try {
        const csRes = await fetch(
          `${SUPABASE_URL}/rest/v1/checkout_sessions?checkout_session_id=eq.${encodeURIComponent(checkoutSessionId)}&select=user_id,sku&limit=1`,
          { headers: svcHeaders() }
        );
        if (csRes.ok) {
          const rows = await csRes.json();
          const row  = Array.isArray(rows) ? rows[0] : null;
          if (row?.user_id && row?.sku) {
            console.log(`ASAAS WEBHOOK resolve: via checkout_sessions (session=${checkoutSessionId})`);
            return { refUserId: row.user_id, refSku: row.sku, source: 'checkout_sessions' };
          }
        } else {
          console.warn(`ASAAS WEBHOOK resolve: SELECT checkout_sessions retornou ${csRes.status}`);
        }
      } catch (e) {
        console.warn('ASAAS WEBHOOK resolve: falha ao consultar checkout_sessions:', e.message);
      }
    }
  }

  console.warn(`ASAAS WEBHOOK resolve: não foi possível resolver user/sku (subscription=${subscriptionId})`);
  return null;
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

  // Log de todos os eventos — whitelist de campos, nunca payload cru (LGPD/segurança).
  // Não logar: dados de cartão, tokens, PAN, objeto payment inteiro.
  {
    const p = event?.payment || {};
    console.log('ASAAS WEBHOOK event:', JSON.stringify({
      event_type:        event?.event,
      payment_id:        p.id,
      payment_status:    p.status,
      payment_value:     p.value,
      payment_dueDate:   p.dueDate,
      payment_externalReference: p.externalReference,
      payment_subscription: p.subscription,
      payment_customer:  p.customer,
    }));
  }

  // SUBSCRIPTION_CREATED não tem dueDate — cai em ignored abaixo.
  const TRIAL_EVENTS   = ['PAYMENT_CREATED'];
  const PAYMENT_EVENTS = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];

  // Evento de criação → trial-grant (acesso imediato antes da 1ª cobrança)
  if (TRIAL_EVENTS.includes(event?.event)) {
    const payment        = event.payment || {};
    const subscriptionId = payment.subscription || null;
    const customerId     = payment.customer;

    const resolved = await resolveUserAndSku(payment);

    // Guard Bloco C: cobrança avulsa da diferença de upgrade — receita, não plano.
    if (resolved && (resolved.refSku === DIFF_MARKER_SKU || resolved.refSku === ADDON_MARKER_SKU)) {
      console.log(`ASAAS WEBHOOK: ignorando ${event?.event} de receita não-plano (${resolved.refSku}) | uid=${resolved.refUserId} — sem tocar plano/validade`);
      return res.status(200).json({ ok: true, ignored: true, source: resolved.refSku, event_type: event?.event });
    }

    if (resolved) {
      const parsed = parsePlanFromSku(resolved.refSku);
      if (parsed) {
        const { plano } = parsed;
        try {
          await grantTrialIfInactive(resolved.refUserId, plano, payment.dueDate || null, customerId, subscriptionId);
        } catch (e) {
          console.error('ASAAS WEBHOOK trial-grant erro:', e.message);
          // Erro interno — responde 200 pro Asaas (não retentar)
        }
      } else {
        console.warn(`ASAAS WEBHOOK trial-grant: SKU não reconhecido (sku=${resolved.refSku})`);
      }
    } else {
      console.warn('ASAAS WEBHOOK trial-grant: não foi possível resolver user/sku — sem acesso concedido');
    }
    return res.status(200).json({ ok: true, source: 'trial_grant', event_type: event?.event });
  }

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
    // ── Fonte primária: resolvedor unificado ──────────────────────────────────
    // externalReference (payload) → GET assinatura (externalReference) → checkout_sessions
    const resolved = await resolveUserAndSku(payment);

    // Guard Bloco C: cobrança avulsa da diferença de upgrade — receita, não plano.
    if (resolved && (resolved.refSku === DIFF_MARKER_SKU || resolved.refSku === ADDON_MARKER_SKU)) {
      console.log(`ASAAS WEBHOOK: ignorando ${event?.event} de receita não-plano (${resolved.refSku}) | uid=${resolved.refUserId} — sem tocar plano/validade`);
      return res.status(200).json({ ok: true, ignored: true, source: resolved.refSku, event_type: event?.event });
    }

    if (resolved) {
      const parsed = parsePlanFromSku(resolved.refSku);

      if (parsed) {
        const { plano, meses } = parsed;
        const subscriptionId = payment.subscription || null;
        const validade = await updateUserPlanByUserId(resolved.refUserId, plano, meses, subscriptionId, customerId);
        // Dispara email transacional. Não-bloqueante — webhook ainda responde 200 mesmo se Resend falhar.
        try {
          await sendPlanoAtivadoByUserId({
            userId:        resolved.refUserId,
            planoSlug:     plano,
            planoValidade: validade,
            valor:         payment.value,
          });
          console.log('[webhook] email "plano ativado" enviado | userId=' + resolved.refUserId);
        } catch (emailErr) {
          console.error('[webhook] falha ao enviar email para userId=' + resolved.refUserId + ':', emailErr.message);
        }
        console.log(`ASAAS WEBHOOK: [resolved:${resolved.source}] plano atualizado | userId=${resolved.refUserId} | plano=${plano} | meses=${meses} | validade=${validade}`);
        return res.status(200).json({ ok: true, source: resolved.source, plano, meses, validade });
      }

      console.warn(`ASAAS WEBHOOK: user/sku resolvido mas sku inválido: "${resolved.refSku}" — tentando fallback`);
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
