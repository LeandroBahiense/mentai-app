const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN; // token configurado no painel Asaas

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

// Detecta plano e duração a partir da description do pagamento
function parsePlanFromDescription(description) {
  const desc = (description || '').toLowerCase();

  let plano = 'essencial';
  if (desc.includes('pro'))      plano = 'pro';
  if (desc.includes('business')) plano = 'business';

  let meses = 1;
  if (desc.includes('semestral')) meses = 6;
  if (desc.includes('anual'))     meses = 12;

  return { plano, meses };
}

async function updateUserPlan(customerId, plano, meses) {
  const validade = new Date();
  validade.setMonth(validade.getMonth() + meses);

  const res = await fetch(
    SUPABASE_URL + '/rest/v1/user_preferences?asaas_customer_id=eq.' + encodeURIComponent(customerId),
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Validação do token do webhook (configurado no painel Asaas)
  if (ASAAS_WEBHOOK_TOKEN) {
    const token = req.headers['asaas-access-token'] || req.headers['x-asaas-token'];
    if (token !== ASAAS_WEBHOOK_TOKEN) {
      console.warn('ASAAS WEBHOOK: token inválido');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = req.body;
  console.log('ASAAS WEBHOOK: event', event?.event, '| payment', event?.payment?.id);

  // Apenas processa pagamentos confirmados
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
    const { plano, meses } = parsePlanFromDescription(description);
    const validade = await updateUserPlan(customerId, plano, meses);

    console.log('ASAAS WEBHOOK: plano atualizado', { customerId, plano, meses, validade });
    return res.status(200).json({ ok: true, plano, validade });
  } catch (err) {
    console.error('ASAAS WEBHOOK ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
