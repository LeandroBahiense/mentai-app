/**
 * Pallyum — Checagem de re-aceite de Termos/Privacidade por versão (LGPD)
 *
 * POST /api/user/consent-status
 *
 * Compara a versão do último consentimento (terms + privacy) do usuário com a
 * versão atual; retorna { needsReaccept: bool }. O bootstrap do app bloqueia
 * com modal se needsReaccept=true.
 *
 * Identidade: cookie pallyum_session. Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { TERMS_VERSION, PRIVACY_VERSION } from '../_lib/versions.js';

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

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Consents de terms + privacy, mais novo primeiro (accepted_at desc)
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/user_consents?user_id=eq.${encodeURIComponent(uid)}&doc_type=in.(terms,privacy)&select=doc_type,doc_version,accepted_at&order=accepted_at.desc`,
      { headers: svcHeaders() }
    );
    if (!resp.ok) {
      console.error('[consent-status] lookup falhou:', resp.status);
      return res.status(500).json({ error: 'consent_lookup_failed' });
    }
    const rows = (await resp.json().catch(() => [])) || [];

    // 1ª ocorrência de cada doc_type = a mais recente (lista já vem desc)
    let termsV = null, privacyV = null;
    for (const r of rows) {
      if (r.doc_type === 'terms'   && termsV   === null) termsV   = r.doc_version;
      if (r.doc_type === 'privacy' && privacyV === null) privacyV = r.doc_version;
    }

    // Comparação de string em datas ISO: '<' = mais antigo
    const needsReaccept =
      (!termsV   || termsV   < TERMS_VERSION) ||
      (!privacyV || privacyV < PRIVACY_VERSION);

    return res.status(200).json({ needsReaccept });

  } catch (e) {
    console.error('[consent-status] erro inesperado:', e.message);
    return res.status(500).json({ error: 'consent_lookup_failed' });
  }
}
