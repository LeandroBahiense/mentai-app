/**
 * Pallyum — Gravação do re-aceite de Termos/Privacidade (LGPD)
 *
 * POST /api/user/reaccept
 *
 * Grava novas linhas em user_consents (terms + privacy) com a versão atual.
 * Chamado pelo gate de re-aceite no bootstrap, após o usuário marcar o aceite.
 *
 * Identidade: cookie pallyum_session. Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { TERMS_VERSION, PRIVACY_VERSION, CONSENT_TEXT_SHOWN } from '../_lib/versions.js';

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

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

// IP server-side (não-forjável) — CÓPIA LITERAL de api/user/briefing-optin.js
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || null;
}

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const ip        = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  // 2 linhas — mesmo shape do insert do signup.js. accepted_at fica no default now() do banco.
  const consentRows = [
    { user_id: uid, doc_type: 'terms',   doc_version: TERMS_VERSION,   ip, user_agent: userAgent, text_shown: CONSENT_TEXT_SHOWN },
    { user_id: uid, doc_type: 'privacy', doc_version: PRIVACY_VERSION, ip, user_agent: userAgent, text_shown: CONSENT_TEXT_SHOWN },
  ];

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/user_consents`, {
      method:  'POST',
      headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
      body:    JSON.stringify(consentRows),
    });
    if (!resp.ok) {
      console.error('[reaccept] INSERT user_consents falhou:', resp.status, await resp.text().catch(() => ''));
      return res.status(500).json({ error: 'reaccept_failed' });
    }
    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error('[reaccept] erro inesperado:', e.message);
    return res.status(500).json({ error: 'reaccept_failed' });
  }
}
