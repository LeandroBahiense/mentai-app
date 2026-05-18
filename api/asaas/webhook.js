/**
 * Pallyum — Webhook Asaas
 * Parseia description no formato: "Pallyum {Label} — {Período}"
 * e atualiza user_preferences.plano + plano_validade
 * Fonte da verdade: Pallyum-Planos-e-Precos.md v1.0
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

// ── Parser canônico ────────────────────────────────────────────────────────────
// Input:  "Pallyum Companion Pro — Mensal"
//         "Pallyum Segundo Cérebro Ultra — Anual"
//         "Pallyum Coletivo Business — Mensal"
//         "Pallyum Duo Essencial — Anual"
//
// Output: { plano: 'companion-pro', meses: 1 }
//         { plano: 'segundo-cerebro-ultra', meses: 12 }
//         { plano: 'coletivo-business', meses: 1 }
//         { plano: 'duo-essencial', meses: 12 }

function parsePlanFromDescription(description) {
  const desc = (description || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Detectar período
  const meses = desc.includes('anual') ? 12 : 1;

  // Detectar produto
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

  // Detectar tier
  let tier = null;
  if (desc.includes('business'))  tier = 'business';
  else if (desc.includes('enterprise')) tier = 'enterprise';
  else if (desc.includes('ultra')) tier = 'ultra';
  else if (desc.includes('pro'))   tier = 'pro';
  else if (desc.includes('team'))  tier = 'team';
  else if (desc.includes('essencial') || desc.includes('essential')) tier = 'essencial';

  if (!produto || !tier) {
    console.warn(`ASAAS WEBHOOK: não foi possível parsear "${description}" | produto=${produto} tier=${tier}`);
    return null;
  }

  const plano = `${produto}-${tier}`;

  // Validação: planos conhecidos
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

// ── Atualiza plano do usuário ──────────────────────────────────────────────────
async function updateUserPlan(customerId, plano, meses) {
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

  // Validação do token do webhook
  if (ASAAS_WEBHOOK_TOKEN) {
    const token = req.headers['asaas-access-token'] || req.headers['x-asaas-token'];
    if (token !== ASAAS_WEBHOOK_TOKEN) {
      console.warn('ASAAS WEBHOOK: token inválido');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = req.body;
  console.log(`ASAAS WEBHOOK: event=${event?.event} | payment=${event?.payment?.id}`);

  // Apenas pagamentos confirmados
  const PAYMENT_EVENTS = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
  if (!PAYMENT_EVENTS.includes(event?.event)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const payment = event.payment;
  if (!payment) {
    console.error('ASAAS WEBHOOK: payload sem payment');
    return res.status(400).json({ error: 'Payload inválido' });
  }

  const customerId  = payment.customer;
  const description = payment.description || '';

  if (!customerId) {
    console.error('ASAAS WEBHOOK: sem customer id');
    return res.status(400).json({ error: 'customer ausente' });
  }

  try {
    const parsed = parsePlanFromDescription(description);

    if (!parsed) {
      console.error(`ASAAS WEBHOOK: não parseable: "${description}"`);
      // Retorna 200 para o Asaas não retentar; logamos para investigação manual
      return res.status(200).json({ ok: false, reason: 'description_not_parseable', description });
    }

    const { plano, meses } = parsed;
    const validade = await updateUserPlan(customerId, plano, meses);

    console.log(`ASAAS WEBHOOK: plano atualizado | customer=${customerId} | plano=${plano} | meses=${meses} | validade=${validade}`);
    return res.status(200).json({ ok: true, plano, meses, validade });

  } catch (err) {
    console.error('ASAAS WEBHOOK ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
