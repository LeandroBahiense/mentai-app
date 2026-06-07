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
import { SKUS } from '../_lib/plans.js';

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

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
// Fonte única de PREÇOS/plano vive em _lib/plans.js (importada aqui).
// Direção do import: rota → lib (sem ciclo). SKU_NAMES (display) segue local.

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
  // Novo catálogo Pallyum (01/06/2026)
  'essencial-mensal':                 'Pallyum Essencial Mensal',
  'pro-mensal':                       'Pallyum Pro Mensal',
  'ultra-mensal':                     'Pallyum Ultra Mensal',
};

// ── Helpers de assinatura recorrente ──────────────────────────────────────────
function deriveCycle(skuKey) {
  if (skuKey.endsWith('-mensal')) return { cycle: 'MONTHLY', months: 1 };
  if (skuKey.endsWith('-anual'))  return { cycle: 'YEARLY',  months: 12 };
  return null;
}

function formatAsaasDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

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

  // Modelo de cobrança: RECURRENT (assinatura).
  // Asaas cobra hoje (no checkout) e gera cobranças automáticas a cada ciclo.
  const cycleInfo = deriveCycle(skuKey);
  if (!cycleInfo) {
    console.error(`CHECKOUT ERR: SKU "${skuKey}" não termina em -mensal nem -anual`);
    return res.status(400).json({ error: `SKU "${skuKey}" não tem ciclo derivável` });
  }

  // nextDueDate = D+7 (horário de Brasília) = data da 1ª cobrança = fim do trial.
  // Asaas cobra no D+7 e ancora o ciclo mensal a partir daí.
  // O acesso ao tier é concedido pelo webhook no evento de CRIAÇÃO (PAYMENT_CREATED /
  // SUBSCRIPTION_CREATED), antes de qualquer cobrança efetiva.
  // endDate = 10 anos no futuro (assinatura "sem fim" — Asaas exige o campo).
  // +7 dias em ms; formatAsaasDate extrai os componentes em horário SP — sem bug UTC.
  // --- Bloco B: "no second trial" — se o usuário já usou trial, 1ª cobrança HOJE (sem nova janela grátis) ---
  let _jaUsouTrial = false;
  try {
    const _prefRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&select=is_trial`,
      { headers: svcHeaders() }
    );
    if (_prefRes.ok) {
      const _rows = await _prefRes.json();
      const _isTrialVal = _rows?.[0]?.is_trial;
      _jaUsouTrial = (_isTrialVal !== null && _isTrialVal !== undefined);
    }
  } catch (e) {
    console.warn('[checkout][Bloco B] lookup is_trial falhou, mantendo trial:', e.message);
  }

  // nextDueDate = data da 1ª cobrança. Trial novo → D+7. Já usou trial → HOJE (cobrança imediata).
  const nextDue = _jaUsouTrial
    ? new Date()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  console.log('[checkout][Bloco B] uid=' + uid + ' jaUsouTrial=' + _jaUsouTrial + ' → nextDue=' + nextDue.toISOString());

  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 10);

  const checkoutBody = {
    billingTypes:    ['CREDIT_CARD'],  // assinatura recorrente: cartão only
    chargeTypes:     ['RECURRENT'],
    minutesToExpire: 60,
    callback: {
      successUrl: 'https://pallyum.com/app?checkout=success',
      expiredUrl: 'https://pallyum.com/app?checkout=expired',
      cancelUrl:  'https://pallyum.com/app?checkout=cancel',
    },
    items: [
      {
        name:     itemName,
        value:    skuData.value,
        quantity: 1,
      },
    ],
    subscription: {
      cycle:             cycleInfo.cycle,
      nextDueDate:       formatAsaasDate(nextDue),
      endDate:           formatAsaasDate(endDate),
      externalReference: uid + '|' + skuKey,   // propagado pra assinatura e suas cobranças
    },
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

    // Mapa {checkout_session_id → user_id, sku} para o webhook resolver a assinatura
    // (o Asaas não propaga externalReference do Checkout Session pra assinatura/cobranças).
    // Falha aqui NÃO bloqueia o checkout — só loga.
    try {
      const csRes = await fetch(`${SUPABASE_URL}/rest/v1/checkout_sessions`, {
        method:  'POST',
        headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          checkout_session_id: asaasData.id,
          user_id:             uid,
          sku:                 skuKey,
        }),
      });
      if (!csRes.ok) {
        console.error('[checkout] INSERT checkout_sessions falhou:', csRes.status, await csRes.text());
      }
    } catch (e) {
      console.error('[checkout] INSERT checkout_sessions erro:', e.message);
    }

    return res.status(200).json({ invoiceUrl });

  } catch (err) {
    console.error('CHECKOUT ERR:', err.message);
    return res.status(500).json({
      error: 'Asaas checkout error: ' + err.message,
    });
  }
}
