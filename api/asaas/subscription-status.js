/**
 * Pallyum — Status de assinatura (para o botão "Cancelar" no app)
 *
 * GET /api/asaas/subscription-status
 *
 * Identidade: cookie pallyum_session (mesmo esquema do checkout).
 * Sem sessão → 401.
 *
 * Consulta subscriptions via service_role e devolve apenas um booleano —
 * o asaas_subscription_id NÃO é exposto ao navegador.
 * Resposta: { canCancel: bool }
 *   canCancel = true  → usuário tem asaas_subscription_id não-nulo em subscriptions
 *   canCancel = false → sem assinatura ativa (ou erro → falha segura)
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { parsePlanFromSku } from '../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

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

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=asaas_subscription_id&limit=1`,
      {
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        },
      }
    );

    if (!resp.ok) {
      console.error('[subscription-status] query falhou:', resp.status);
      // Falha segura: não mostrar botão de cancelamento
      return res.status(200).json({ canCancel: false, scheduledPlano: null, nextDueDate: null });
    }

    const rows = await resp.json();
    const subscriptionId = rows?.[0]?.asaas_subscription_id || null;
    const canCancel = !!subscriptionId;

    // Plano AGENDADO da assinatura (o que será cobrado no próximo ciclo) + data.
    // Read-only: GET na assinatura Asaas. Falha aqui NÃO derruba canCancel — só
    // deixa os campos novos null (front cai no comportamento sem-agendamento).
    let scheduledPlano = null;
    let nextDueDate    = null;
    if (subscriptionId) {
      try {
        const subRes = await fetch(
          `${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}`,
          { headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY } }
        );
        if (subRes.ok) {
          const subData = await subRes.json();
          nextDueDate    = subData?.nextDueDate || null;
          const sku      = (subData?.externalReference || '').split('|')[1] || '';
          scheduledPlano = parsePlanFromSku(sku)?.plano || null;
        } else {
          console.error('[subscription-status] GET subscription Asaas retornou', subRes.status);
        }
      } catch (e) {
        console.error('[subscription-status] GET subscription Asaas erro:', e.message);
      }
    }

    return res.status(200).json({ canCancel, scheduledPlano, nextDueDate });

  } catch (e) {
    console.error('[subscription-status] erro inesperado:', e.message);
    // Falha segura: não mostrar botão
    return res.status(200).json({ canCancel: false, scheduledPlano: null, nextDueDate: null });
  }
}
