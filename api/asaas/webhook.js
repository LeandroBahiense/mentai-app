/**
 * Pallyum — Webhook Asaas
 * Fonte primária : payment.externalReference = "userId|sku"
 * Fallback       : parsePlanFromDescription(payment.description)
 * Atualiza user_preferences.plano + plano_validade
 */

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
async function updateUserPlanByUserId(userId, plano, meses) {
  const validade = new Date();
  validade.setMonth(validade.getMonth() + meses);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body: JSON.stringify({
        plano,
        plano_validade: validade.toISOString(),
        updated_at:     new Date().toISOString(),
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase PATCH falhou: ' + err);
  }

  return validade.toISOString();
}

// ── Atualiza plano por asaas_customer_id (fallback para pagamentos antigos) ────
async function updateUserPlanByCustomer(customerId, plano, meses) {
  const validade = new Date();
  validade.setMonth(validade.getMonth() + meses);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?asaas_customer_id=eq.${encodeURIComponent(customerId)}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body: JSON.stringify({
        plano,
        plano_validade: validade.toISOString(),
        updated_at:     new Date().toISOString(),
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase PATCH falhou: ' + err);
  }

  return validade.toISOString();
}

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (ASAAS_WEBHOOK_TOKEN) {
    const token = req.headers['asaas-access-token'] || req.headers['x-asaas-token'];
    if (token !== ASAAS_WEBHOOK_TOKEN) {
      console.warn('ASAAS WEBHOOK: token inválido');
      return res.status(401).json({ error: 'Unauthorized' });
    }
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

  const externalRef  = payment.externalReference || '';
  const customerId   = payment.customer;
  const description  = payment.description || '';

  try {
    // ── Fonte primária: externalReference = "userId|sku" ──────────────────────
    const [refUserId, refSku] = externalRef.split('|');

    if (refUserId && refSku) {
      const parsed = parsePlanFromSku(refSku);

      if (parsed) {
        const { plano, meses } = parsed;
        const validade = await updateUserPlanByUserId(refUserId, plano, meses);
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
    const validade = await updateUserPlanByCustomer(customerId, plano, meses);
    console.log(`ASAAS WEBHOOK: [description fallback] plano atualizado | customer=${customerId} | plano=${plano} | meses=${meses} | validade=${validade}`);
    return res.status(200).json({ ok: true, source: 'description_fallback', plano, meses, validade });

  } catch (err) {
    console.error('ASAAS WEBHOOK ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
