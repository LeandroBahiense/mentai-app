/**
 * Pallyum — Checkout Asaas (Hosted Checkout)
 * Usa o produto "Asaas Checkout" — link de pagamento hospedado.
 * O Asaas coleta CPF e dados de pagamento diretamente.
 * 24 SKUs: Companion | Segundo Cérebro | Coletivo | Duo — mensal/anual
 *
 * Identidade do usuário derivada do cookie de sessão (readSession),
 * não do corpo da requisição — evita forjamento de userId.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
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

// ── Tabela de SKUs ─────────────────────────────────────────────────────────────
// Chave: "{produto}-{tier}-{periodo}"
const SKUS = {
  // Companion (mensal)
  'companion-essencial-mensal':       { value: 29.00,   plano: 'companion-essencial'       },
  'companion-pro-mensal':             { value: 59.00,   plano: 'companion-pro'             },
  'companion-ultra-mensal':           { value: 89.00,   plano: 'companion-ultra'           },
  // Companion (anual)
  'companion-essencial-anual':        { value: 300.00,  plano: 'companion-essencial'       },
  'companion-pro-anual':              { value: 600.00,  plano: 'companion-pro'             },
  'companion-ultra-anual':            { value: 900.00,  plano: 'companion-ultra'           },

  // Segundo Cérebro (mensal)
  'segundo-cerebro-essencial-mensal': { value: 59.00,   plano: 'segundo-cerebro-essencial' },
  'segundo-cerebro-pro-mensal':       { value: 99.00,   plano: 'segundo-cerebro-pro'       },
  'segundo-cerebro-ultra-mensal':     { value: 169.00,  plano: 'segundo-cerebro-ultra'     },
  // Segundo Cérebro (anual)
  'segundo-cerebro-essencial-anual':  { value: 600.00,  plano: 'segundo-cerebro-essencial' },
  'segundo-cerebro-pro-anual':        { value: 1000.00, plano: 'segundo-cerebro-pro'       },
  'segundo-cerebro-ultra-anual':      { value: 1700.00, plano: 'segundo-cerebro-ultra'     },

  // Coletivo (mensal)
  'coletivo-team-mensal':             { value: 399.00,  plano: 'coletivo-team'             },
  'coletivo-business-mensal':         { value: 699.00,  plano: 'coletivo-business'         },
  // Coletivo (anual)
  'coletivo-team-anual':              { value: 4000.00, plano: 'coletivo-team'             },
  'coletivo-business-anual':          { value: 7000.00, plano: 'coletivo-business'         },

  // Duo Essencial
  'duo-essencial-mensal':             { value: 79.00,   plano: 'duo-essencial'             },
  'duo-essencial-anual':              { value: 790.00,  plano: 'duo-essencial'             },
  // Duo Pro
  'duo-pro-mensal':                   { value: 139.00,  plano: 'duo-pro'                   },
  'duo-pro-anual':                    { value: 1390.00, plano: 'duo-pro'                   },
  // Duo Ultra
  'duo-ultra-mensal':                 { value: 229.00,  plano: 'duo-ultra'                 },
  'duo-ultra-anual':                  { value: 2290.00, plano: 'duo-ultra'                 },
};

// ── Nomes curtos por SKU (max 30 chars — limite Asaas) ────────────────────────
const SKU_NAMES = {
  'companion-essencial-mensal':       'Companion Essencial Mensal',
  'companion-pro-mensal':             'Companion Pro Mensal',
  'companion-ultra-mensal':           'Companion Ultra Mensal',
  'companion-essencial-anual':        'Companion Essencial Anual',
  'companion-pro-anual':              'Companion Pro Anual',
  'companion-ultra-anual':            'Companion Ultra Anual',
  'segundo-cerebro-essencial-mensal': 'Seg Cérebro Essencial Mensal',
  'segundo-cerebro-pro-mensal':       'Seg Cérebro Pro Mensal',
  'segundo-cerebro-ultra-mensal':     'Seg Cérebro Ultra Mensal',
  'segundo-cerebro-essencial-anual':  'Seg Cérebro Essencial Anual',
  'segundo-cerebro-pro-anual':        'Seg Cérebro Pro Anual',
  'segundo-cerebro-ultra-anual':      'Seg Cérebro Ultra Anual',
  'coletivo-team-mensal':             'Coletivo Team Mensal',
  'coletivo-business-mensal':         'Coletivo Business Mensal',
  'coletivo-team-anual':              'Coletivo Team Anual',
  'coletivo-business-anual':          'Coletivo Business Anual',
  'duo-essencial-mensal':             'Duo Essencial Mensal',
  'duo-pro-mensal':                   'Duo Pro Mensal',
  'duo-ultra-mensal':                 'Duo Ultra Mensal',
  'duo-essencial-anual':              'Duo Essencial Anual',
  'duo-pro-anual':                    'Duo Pro Anual',
  'duo-ultra-anual':                  'Duo Ultra Anual',
};

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const uid = readSession(req);
  if (!uid) {
    return res.status(401).json({ error: 'sessão inválida' });
  }

  const { sku } = req.body || {};

  // Fallback: aceita {plano, ciclo} legado
  let skuKey = sku;
  if (!skuKey && req.body?.plano && req.body?.ciclo) {
    skuKey = `companion-${req.body.plano}-${req.body.ciclo}`;
  }

  if (!skuKey) {
    return res.status(400).json({ error: 'Campo obrigatório: sku' });
  }

  const skuData = SKUS[skuKey];
  if (!skuData) {
    return res.status(400).json({
      error: `SKU inválido: "${skuKey}". Disponíveis: ${Object.keys(SKUS).join(', ')}`,
    });
  }

  const itemName = SKU_NAMES[skuKey] || skuKey;

  console.log(`CHECKOUT: uid=${uid} | sku=${skuKey} | valor=R$${skuData.value}`);

  const checkoutBody = {
    billingTypes:    ['CREDIT_CARD'],  // só cartão para teste inicial
    chargeTypes:     ['DETACHED'],
    minutesToExpire: 60,
    callback: {
      successUrl: 'https://pallyum.com/app?checkout=success',
      expiredUrl:  'https://pallyum.com/app?checkout=expired',
      cancelUrl:   'https://pallyum.com/app?checkout=cancel',
    },
    items: [
      {
        name:     itemName,
        value:    skuData.value,
        quantity: 1,
      },
    ],
    externalReference: uid + '|' + skuKey,
  };

  try {
    const asaasRes = await fetch(`${ASAAS_BASE_URL}/checkouts`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY,
      },
      body: JSON.stringify(checkoutBody),
    });

    const asaasData = await asaasRes.json();

    if (!asaasData.id) {
      console.error('CHECKOUT ERR Asaas:', JSON.stringify(asaasData));
      return res.status(500).json({
        error: 'Asaas checkout error: ' + JSON.stringify(asaasData),
      });
    }

    const invoiceUrl = asaasData.link || asaasData.url;
    console.log(`CHECKOUT: link gerado | id=${asaasData.id} | url=${invoiceUrl}`);

    return res.status(200).json({ invoiceUrl });

  } catch (err) {
    console.error('CHECKOUT ERR:', err.message);
    return res.status(500).json({
      error: 'Asaas checkout error: ' + err.message,
    });
  }
}
