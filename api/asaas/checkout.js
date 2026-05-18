/**
 * Pallyum — Checkout Asaas
 * 24 SKUs: 9 Companion/Segundo Cérebro/Coletivo mensais +
 *          9 anuais + 3 Duo mensais + 3 Duo anuais
 * Fonte da verdade: Pallyum-Planos-e-Precos.md v1.0
 */

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_API_KEY    = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL   = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

// ── Tabela de SKUs Pallyum ─────────────────────────────────────────────────────
//
// Chave: "{produto}-{tier}-{periodo}"
// produto : companion | segundo-cerebro | coletivo | duo
// tier    : essencial | pro | ultra | team | business
// periodo : mensal | anual
//
const SKUS = {
  // Companion (mensal)
  'companion-essencial-mensal':       { value: 29.00,   plano: 'companion-essencial',       meses: 1  },
  'companion-pro-mensal':             { value: 59.00,   plano: 'companion-pro',             meses: 1  },
  'companion-ultra-mensal':           { value: 89.00,   plano: 'companion-ultra',           meses: 1  },
  // Companion (anual)
  'companion-essencial-anual':        { value: 300.00,  plano: 'companion-essencial',       meses: 12 },
  'companion-pro-anual':              { value: 600.00,  plano: 'companion-pro',             meses: 12 },
  'companion-ultra-anual':            { value: 900.00,  plano: 'companion-ultra',           meses: 12 },

  // Segundo Cérebro (mensal)
  'segundo-cerebro-essencial-mensal': { value: 59.00,   plano: 'segundo-cerebro-essencial', meses: 1  },
  'segundo-cerebro-pro-mensal':       { value: 99.00,   plano: 'segundo-cerebro-pro',       meses: 1  },
  'segundo-cerebro-ultra-mensal':     { value: 169.00,  plano: 'segundo-cerebro-ultra',     meses: 1  },
  // Segundo Cérebro (anual)
  'segundo-cerebro-essencial-anual':  { value: 600.00,  plano: 'segundo-cerebro-essencial', meses: 12 },
  'segundo-cerebro-pro-anual':        { value: 1000.00, plano: 'segundo-cerebro-pro',       meses: 12 },
  'segundo-cerebro-ultra-anual':      { value: 1700.00, plano: 'segundo-cerebro-ultra',     meses: 12 },

  // Coletivo (mensal)
  'coletivo-team-mensal':             { value: 399.00,  plano: 'coletivo-team',             meses: 1  },
  'coletivo-business-mensal':         { value: 699.00,  plano: 'coletivo-business',         meses: 1  },
  // Coletivo (anual)
  'coletivo-team-anual':              { value: 4000.00, plano: 'coletivo-team',             meses: 12 },
  'coletivo-business-anual':          { value: 7000.00, plano: 'coletivo-business',         meses: 12 },

  // Duo Essencial (Companion Essencial + Segundo Cérebro Essencial)
  'duo-essencial-mensal':             { value: 79.00,   plano: 'duo-essencial',             meses: 1  },
  'duo-essencial-anual':              { value: 790.00,  plano: 'duo-essencial',             meses: 12 },
  // Duo Pro (Companion Pro + Segundo Cérebro Pro)
  'duo-pro-mensal':                   { value: 139.00,  plano: 'duo-pro',                   meses: 1  },
  'duo-pro-anual':                    { value: 1390.00, plano: 'duo-pro',                   meses: 12 },
  // Duo Ultra (Companion Ultra + Segundo Cérebro Ultra)
  'duo-ultra-mensal':                 { value: 229.00,  plano: 'duo-ultra',                 meses: 1  },
  'duo-ultra-anual':                  { value: 2290.00, plano: 'duo-ultra',                 meses: 12 },
};

// ── Description canônica para o webhook parsear ────────────────────────────────
// Formato: "Pallyum {Label} — {Período}"
const SKU_LABELS = {
  'companion-essencial':       'Companion Essencial',
  'companion-pro':             'Companion Pro',
  'companion-ultra':           'Companion Ultra',
  'segundo-cerebro-essencial': 'Segundo Cérebro Essencial',
  'segundo-cerebro-pro':       'Segundo Cérebro Pro',
  'segundo-cerebro-ultra':     'Segundo Cérebro Ultra',
  'coletivo-team':             'Coletivo Team',
  'coletivo-business':         'Coletivo Business',
  'duo-essencial':             'Duo Essencial',
  'duo-pro':                   'Duo Pro',
  'duo-ultra':                 'Duo Ultra',
};

function buildDescription(plano, periodo) {
  const label = SKU_LABELS[plano] || plano;
  const per   = periodo === 'anual' ? 'Anual' : 'Mensal';
  return `Pallyum ${label} — ${per}`;
}

// ── Supabase helpers ───────────────────────────────────────────────────────────
function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

async function getPrefs(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${userId}&limit=1`,
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function saveAsaasCustomerId(userId, asaasCustomerId) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${userId}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body: JSON.stringify({ asaas_customer_id: asaasCustomerId, updated_at: new Date().toISOString() }),
    }
  );
}

// ── Asaas helpers ──────────────────────────────────────────────────────────────
function asaasHeaders() {
  return {
    'Content-Type': 'application/json',
    'access_token': ASAAS_API_KEY,
  };
}

async function findOrCreateCustomer({ name, email, cpfCnpj, phone }) {
  const searchRes = await fetch(
    `${ASAAS_BASE_URL}/customers?email=${encodeURIComponent(email)}&limit=1`,
    { headers: asaasHeaders() }
  );
  const searchData = await searchRes.json();
  if (searchData.data && searchData.data.length > 0) {
    return searchData.data[0].id;
  }

  const body = { name, email };
  if (cpfCnpj) body.cpfCnpj = cpfCnpj.replace(/\D/g, '');
  if (phone)   body.mobilePhone = phone.replace(/\D/g, '');

  const createRes = await fetch(`${ASAAS_BASE_URL}/customers`, {
    method:  'POST',
    headers: asaasHeaders(),
    body:    JSON.stringify(body),
  });
  const customer = await createRes.json();
  if (!customer.id) throw new Error('Asaas customer error: ' + JSON.stringify(customer));
  return customer.id;
}

async function createPayment({ customerId, value, description, dueDate }) {
  const res = await fetch(`${ASAAS_BASE_URL}/payments`, {
    method:  'POST',
    headers: asaasHeaders(),
    body: JSON.stringify({
      customer:    customerId,
      billingType: 'UNDEFINED', // usuário escolhe PIX / boleto / cartão
      value:       parseFloat(value),
      dueDate,
      description,
    }),
  });
  const data = await res.json();
  if (!data.id) throw new Error('Asaas payment error: ' + JSON.stringify(data));
  return data;
}

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { userId, sku, email, name, cpfCnpj, phone } = req.body || {};

  // sku format: "{produto}-{tier}-{periodo}"
  // Fallback: aceita também {produto, plano, ciclo} legado
  let skuKey = sku;
  if (!skuKey && req.body?.plano && req.body?.ciclo) {
    // compatibilidade com chamadas antigas (plano = 'essencial', ciclo = 'mensal')
    // tentativa de mapear para novo formato
    skuKey = `companion-${req.body.plano}-${req.body.ciclo}`;
  }

  if (!userId || !skuKey || !email || !name) {
    return res.status(400).json({ error: 'Campos obrigatórios: userId, sku, email, name' });
  }

  const skuData = SKUS[skuKey];
  if (!skuData) {
    const available = Object.keys(SKUS).join(', ');
    return res.status(400).json({ error: `SKU inválido: "${skuKey}". Disponíveis: ${available}` });
  }

  console.log(`CHECKOUT: userId=${userId} | sku=${skuKey} | plano=${skuData.plano} | valor=R$${skuData.value}`);

  try {
    // Busca customer_id salvo
    const prefs = await getPrefs(userId);
    let asaasCustomerId = prefs?.asaas_customer_id || null;

    if (!asaasCustomerId) {
      asaasCustomerId = await findOrCreateCustomer({ name, email, cpfCnpj, phone });
      await saveAsaasCustomerId(userId, asaasCustomerId);
      console.log('CHECKOUT: novo customer Asaas', asaasCustomerId);
    } else {
      console.log('CHECKOUT: customer existente', asaasCustomerId);
    }

    // Vencimento D+1
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 1);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const periodo    = skuKey.endsWith('-anual') ? 'anual' : 'mensal';
    const description = buildDescription(skuData.plano, periodo);

    const payment = await createPayment({
      customerId: asaasCustomerId,
      value:      skuData.value,
      description,
      dueDate:    dueDateStr,
    });

    console.log(`CHECKOUT: payment criado ${payment.id} | R$${skuData.value}`);

    return res.status(200).json({
      ok:           true,
      paymentId:    payment.id,
      invoiceUrl:   payment.invoiceUrl,
      bankSlipUrl:  payment.bankSlipUrl  || null,
      pixCode:      payment.pixQrCode?.payload       || null,
      pixQrCodeUrl: payment.pixQrCode?.encodedImage  || null,
      value:        skuData.value,
      sku:          skuKey,
      plano:        skuData.plano,
      meses:        skuData.meses,
      dueDate:      dueDateStr,
    });

  } catch (err) {
    console.error('CHECKOUT ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
