/**
 * Pallyum — WhatsApp: status de conexão do usuário logado
 *
 * GET /api/whatsapp/status
 *
 * Identidade: cookie pallyum_session (mesmo esquema do checkout e do activate).
 * Sem sessão → 401.
 *
 * Consulta phone_users pelo user_id da sessão (service role).
 * Retorna { connected: bool, phone: string|null }
 *   - connected = true  → usuário tem ao menos um número vinculado; phone = o primeiro
 *   - connected = false → nenhuma linha encontrada; phone = null
 */

import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_users?user_id=eq.${encodeURIComponent(userId)}&select=phone&limit=1`,
      { headers: svcHeaders() }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[whatsapp/status] query phone_users falhou:', err);
      return res.status(500).json({ error: 'Erro ao consultar status' });
    }

    const rows = await resp.json();
    const phone = rows?.[0]?.phone || null;

    return res.status(200).json({ connected: !!phone, phone });

  } catch (e) {
    console.error('[whatsapp/status] erro inesperado:', e.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
}
