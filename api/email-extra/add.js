/**
 * Pallyum — comprar slot de e-mail avulso (add-on pré-pago, +R$15/mês). 03.4b.
 *
 * POST /api/email-extra/add  (sem body)
 * Espelha api/asaas/plan-change.js: mesmo ASAAS_BASE_URL, header access_token,
 * getClientIp, dataHojeSP, checagem de status da cobrança.
 *
 * Fluxo (MOVE DINHEIRO):
 *   1) sessão → uid; 2) lê assinatura/customer; 3) token do cartão;
 *   4) cobra R$15 NA HORA (só prossegue se CONFIRMED/RECEIVED);
 *   5) cria assinatura recorrente R$15/mês (token, sem novo checkout);
 *   6) registra account_addons status='active'; 7) 200.
 *
 * Auth: cookie pallyum_session (cópia literal do checkout). Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { dataHojeSP } from '../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

const ADDON_VALUE   = 15;
const ADDON_MARKER  = 'email_extra';

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

// nextDueDate = hoje (SP) + 1 mês, em 'YYYY-MM-DD'. Aritmética em UTC sobre os
// componentes da data SP — evita drift de fuso. A 1ª cobrança já foi feita HOJE
// (passo 4), então a recorrente começa daqui a um mês.
function umMesDepoisSP() {
  const [y, m, d] = dataHojeSP().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, d)); // m = índice do PRÓXIMO mês (m-1 atual +1)
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'sessão inválida' });

  // 2. Assinatura/customer do usuário.
  let subscriptionId = null, customerId = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=asaas_subscription_id,asaas_customer_id&limit=1`,
      { headers: svcHeaders() }
    );
    if (!r.ok) {
      console.error('[email-extra] query subscriptions falhou:', r.status);
      return res.status(500).json({ error: 'erro_consulta' });
    }
    const rows = await r.json();
    subscriptionId = rows?.[0]?.asaas_subscription_id || null;
    customerId     = rows?.[0]?.asaas_customer_id || null;
  } catch (e) {
    console.error('[email-extra] erro lendo subscriptions:', e.message);
    return res.status(500).json({ error: 'erro_consulta' });
  }

  // Sem assinatura/customer (ex.: trial sem cartão) → não compra avulso.
  if (!subscriptionId || !customerId) {
    return res.status(400).json({ error: 'sem_assinatura' });
  }

  // 3. Token do cartão salvo (da assinatura).
  let creditCardToken = null;
  try {
    const getR = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: asaasHeaders(),
    });
    if (getR.ok) {
      const subData = await getR.json();
      creditCardToken = subData?.creditCard?.creditCardToken || null;
    } else {
      console.error('[email-extra] GET subscription Asaas retornou', getR.status);
    }
  } catch (e) {
    console.error('[email-extra] GET subscription erro:', e.message);
  }
  if (!creditCardToken) {
    return res.status(400).json({ error: 'sem_cartao' });
  }

  // 4. COBRA NA HORA (igual ao upgrade). Só prossegue se capturada.
  let payData = {};
  try {
    const payR = await fetch(`${ASAAS_BASE_URL}/payments`, {
      method:  'POST',
      headers: asaasHeaders(),
      body: JSON.stringify({
        customer:          customerId,
        billingType:       'CREDIT_CARD',
        value:             ADDON_VALUE,
        dueDate:           dataHojeSP(),
        creditCardToken:   creditCardToken,
        externalReference: `${uid}|${ADDON_MARKER}`,
        remoteIp:          getClientIp(req),
      }),
    });
    payData = await payR.json().catch(() => ({}));
  } catch (e) {
    console.error('[email-extra] POST /payments erro:', e.message);
    return res.status(402).json({ error: 'cobranca_recusada' });
  }
  if (!['CONFIRMED', 'RECEIVED'].includes(payData.status)) {
    console.error(`[email-extra] cobrança não capturada | uid=${uid} | status=${payData.status} | body=${JSON.stringify(payData)}`);
    return res.status(402).json({ error: 'cobranca_recusada' });
  }
  console.log(`[email-extra] cobrança HOJE ok | uid=${uid} | payment=${payData.id} | status=${payData.status}`);

  // A partir daqui o cliente JÁ PAGOU. Priorizar entregar o slot: mesmo que a
  // assinatura recorrente ou o INSERT falhem, registrar o add-on e logar para
  // reconciliação — não devolver erro que esconda o pagamento já feito.

  // 5. RECORRENTE: assinatura R$15/mês só com o token (sem novo checkout).
  let addonSubId = null;
  try {
    const subR = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
      method:  'POST',
      headers: asaasHeaders(),
      body: JSON.stringify({
        customer:          customerId,
        billingType:       'CREDIT_CARD',
        cycle:             'MONTHLY',
        value:             ADDON_VALUE,
        creditCardToken:   creditCardToken,
        nextDueDate:       umMesDepoisSP(),
        externalReference: `${uid}|${ADDON_MARKER}`,
      }),
    });
    const subData = await subR.json().catch(() => ({}));
    addonSubId = subData?.id || null;
    if (!addonSubId) {
      console.error(`[email-extra] CRÍTICO: cobrança feita mas assinatura recorrente falhou | uid=${uid} | status=${subR.status} | body=${JSON.stringify(subData)}`);
    } else {
      console.log(`[email-extra] assinatura recorrente criada | uid=${uid} | sub=${addonSubId}`);
    }
  } catch (e) {
    console.error(`[email-extra] CRÍTICO: cobrança feita mas POST /subscriptions erro | uid=${uid} | ${e.message}`);
  }

  // 6. Registra o add-on (active). Mesmo com addonSubId null, o slot foi pago.
  //    Se ESTE insert falhar, o cliente pagou e o slot NÃO entrou → não mentir
  //    com ok:true; devolver 500 addon_partial p/ o suporte reconciliar.
  const paymentId = payData.id || null;
  let addonInserted = false;
  try {
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/account_addons`, {
      method:  'POST',
      headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id:               uid,
        asaas_subscription_id: addonSubId,
        status:                'active',
      }),
    });
    if (insRes.ok) {
      addonInserted = true;
    } else {
      const err = await insRes.text();
      console.error(`[email-extra] CRÍTICO: cobrança feita mas INSERT account_addons falhou | uid=${uid} | payment=${paymentId} | addonSub=${addonSubId} | ${insRes.status} | ${err}`);
    }
  } catch (e) {
    console.error(`[email-extra] CRÍTICO: INSERT account_addons erro | uid=${uid} | payment=${paymentId} | addonSub=${addonSubId} | ${e.message}`);
  }

  // 7. Só devolve ok:true se o slot de fato entrou. Senão: pagou mas o slot não
  //    entrou — 500 addon_partial (não esconder o pagamento já feito).
  if (!addonInserted) {
    return res.status(500).json({ error: 'addon_partial' });
  }
  return res.status(200).json({ ok: true });
}
