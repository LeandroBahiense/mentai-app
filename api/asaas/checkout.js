const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_API_KEY    = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL   = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

// ─── Tabela de preços (em centavos → BRL) ─────────────────────────────────────

const PRECOS = {
  essencial: { mensal: 49.00,  semestral: 264.00,  anual: 468.00  },
  pro:       { mensal: 89.00,  semestral: 480.00,  anual: 852.00  },
  business:  { mensal: 149.00, semestral: 804.00,  anual: 1428.00 },
};

// Descrição usada no pagamento — deve conter plano e ciclo para o webhook parsear
function buildDescription(plano, ciclo, displayName) {
  const nome = displayName ? ' — ' + displayName : '';
  return 'Koreo ' + capitalize(plano) + ' ' + capitalize(ciclo) + nome;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}


function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

function asaasHeaders() {
  return {
    'Content-Type': 'application/json',
    'access_token': ASAAS_API_KEY,
  };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getPrefs(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/user_preferences?user_id=eq.' + userId + '&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function saveAsaasCustomerId(userId, asaasCustomerId) {
  await fetch(
    SUPABASE_URL + '/rest/v1/user_preferences?user_id=eq.' + userId,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body: JSON.stringify({ asaas_customer_id: asaasCustomerId, updated_at: new Date().toISOString() }),
    }
  );
}

// ─── Asaas helpers ────────────────────────────────────────────────────────────

async function findOrCreateCustomer({ name, email, cpfCnpj, phone }) {
  // Tenta buscar por email primeiro
  const searchRes = await fetch(
    ASAAS_BASE_URL + '/customers?email=' + encodeURIComponent(email) + '&limit=1',
    { headers: asaasHeaders() }
  );
  const searchData = await searchRes.json();
  if (searchData.data && searchData.data.length > 0) {
    return searchData.data[0].id;
  }

  // Cria novo cliente
  const body = { name, email };
  if (cpfCnpj) body.cpfCnpj = cpfCnpj.replace(/\D/g, '');
  if (phone)   body.mobilePhone = phone.replace(/\D/g, '');

  const createRes = await fetch(ASAAS_BASE_URL + '/customers', {
    method:  'POST',
    headers: asaasHeaders(),
    body:    JSON.stringify(body),
  });
  const customer = await createRes.json();
  if (!customer.id) throw new Error('Asaas customer error: ' + JSON.stringify(customer));
  return customer.id;
}

async function createPayment({ customerId, value, description, billingType, dueDate }) {
  const body = {
    customer:    customerId,
    billingType: billingType || 'UNDEFINED', // UNDEFINED = link de pagamento (usuário escolhe)
    value:       parseFloat(value),
    dueDate,
    description,
  };

  const res = await fetch(ASAAS_BASE_URL + '/payments', {
    method:  'POST',
    headers: asaasHeaders(),
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.id) throw new Error('Asaas payment error: ' + JSON.stringify(data));
  return data;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { userId, plano, ciclo, email, name, cpfCnpj, phone } = req.body || {};

  // Validações básicas
  if (!userId || !plano || !ciclo || !email || !name) {
    return res.status(400).json({ error: 'Campos obrigatórios: userId, plano, ciclo, email, name' });
  }

  if (!PRECOS[plano]) {
    return res.status(400).json({ error: 'Plano inválido. Use: essencial, pro, business' });
  }

  if (!PRECOS[plano][ciclo]) {
    return res.status(400).json({ error: 'Ciclo inválido. Use: mensal, semestral, anual' });
  }

  console.log('CHECKOUT: userId', userId, '| plano', plano, '| ciclo', ciclo);

  try {
    // Busca prefs para checar se já tem customer_id
    const prefs = await getPrefs(userId);
    let asaasCustomerId = prefs?.asaas_customer_id || null;

    // Cria ou reutiliza cliente no Asaas
    if (!asaasCustomerId) {
      asaasCustomerId = await findOrCreateCustomer({ name, email, cpfCnpj, phone });
      await saveAsaasCustomerId(userId, asaasCustomerId);
      console.log('CHECKOUT: novo customer Asaas', asaasCustomerId);
    } else {
      console.log('CHECKOUT: customer existente', asaasCustomerId);
    }

    // Calcula valor e vencimento (D+1 para dar tempo de pagar)
    const value    = PRECOS[plano][ciclo].toFixed(2);
    const dueDate  = new Date();
    dueDate.setDate(dueDate.getDate() + 1);
    const dueDateStr = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD

    const displayName = prefs?.display_name || name;
    const description = buildDescription(plano, ciclo, displayName);

    // Cria cobrança (UNDEFINED = link genérico, usuário escolhe PIX/boleto/cartão)
    const payment = await createPayment({
      customerId:  asaasCustomerId,
      value,
      description,
      billingType: 'UNDEFINED',
      dueDate:     dueDateStr,
    });

    console.log('CHECKOUT: payment criado', payment.id, '| valor R$', value);

    return res.status(200).json({
      ok:           true,
      paymentId:    payment.id,
      invoiceUrl:   payment.invoiceUrl,
      bankSlipUrl:  payment.bankSlipUrl || null,
      pixCode:      payment.pixQrCode?.payload || null,
      pixQrCodeUrl: payment.pixQrCode?.encodedImage || null,
      value:        parseFloat(value),
      plano,
      ciclo,
      dueDate:      dueDateStr,
    });

  } catch (err) {
    console.error('CHECKOUT ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
