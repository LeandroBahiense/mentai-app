/**
 * Pallyum — início da adesão Nylas (hosted auth).
 * GET autenticado (cookie pallyum_session) → 302 para o seletor de provedor da Nylas.
 * State assinado HMAC-SHA256 (mesmo mecanismo de api/auth/google.js / callback.js).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { buildNylasAuthUrl } from '../_lib/nylas.js';

// ── readSession — CÓPIA LITERAL de api/google-accounts.js ───────────────────
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

// ── signState — CÓPIA LITERAL de api/auth/google.js ──────────────────────────
function signState(payload) {
  const b64 = toBase64url(JSON.stringify(payload));
  const sig = toBase64url(createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest());
  return b64 + '.' + sig;
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const state = signState({ user_id: uid, ts: Date.now() });
  return res.redirect(302, buildNylasAuthUrl(state));
}
