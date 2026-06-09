/**
 * Pallyum — callback da adesão Nylas (hosted auth). [CUIDADO: escreve no banco]
 * GET: valida state HMAC, troca code por grant, resolve calendar primário e
 * faz UPSERT em nylas_grants (service role, mesmo padrão do google_tokens).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { exchangeCodeForGrant, getPrimaryCalendarId } from '../_lib/nylas.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 min

// ── verifyState — CÓPIA LITERAL de api/auth/callback.js ──────────────────────
function toBase64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const dot = state.lastIndexOf('.');
  if (dot === -1) return null;
  const b64    = state.slice(0, dot);
  const sigRecv = state.slice(dot + 1);
  const expected = toBase64url(createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest());
  try {
    const a = Buffer.from(sigRecv), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('NYLAS CALLBACK: provider retornou error=', error);
    return res.redirect(302, 'https://pallyum.com/app?nylas=error');
  }

  // ── Valida state (assinatura + idade <= 10min) ──────────────────────────────
  const st = verifyState(state || '');
  if (!st || !st.user_id) {
    console.warn('NYLAS CALLBACK: state inválido');
    return res.redirect(302, 'https://pallyum.com/app?nylas=error');
  }
  if (!st.ts || (Date.now() - st.ts) > STATE_MAX_AGE_MS) {
    console.warn('NYLAS CALLBACK: state expirado');
    return res.redirect(302, 'https://pallyum.com/app?nylas=error');
  }
  const uid = st.user_id;

  if (!code) {
    console.warn('NYLAS CALLBACK: sem code');
    return res.redirect(302, 'https://pallyum.com/app?nylas=error');
  }

  try {
    // ── Troca code por grant ──────────────────────────────────────────────────
    const { grantId, email, provider } = await exchangeCodeForGrant(code);
    if (!grantId) {
      console.error('NYLAS CALLBACK: exchange sem grant_id');
      return res.redirect(302, 'https://pallyum.com/app?nylas=error');
    }

    // ── Resolve calendar primário (best-effort: null se não houver) ───────────
    let calendarId = null;
    try {
      calendarId = await getPrimaryCalendarId(grantId);
    } catch (e) {
      console.warn('NYLAS CALLBACK: getPrimaryCalendarId falhou (segue com null):', e.message);
    }

    // ── UPSERT em nylas_grants (service role; on_conflict=user_id,email) ───────
    const upsertBody = {
      user_id:     uid,
      email:       email || null,
      provider:    provider || null,
      grant_id:    grantId,
      is_primary:  false,
      calendar_id: calendarId,
      status:      'active',
    };

    const upsertRes = await fetch(SUPABASE_URL + '/rest/v1/nylas_grants?on_conflict=user_id,email', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify(upsertBody),
    });

    if (upsertRes.status >= 400) {
      const errText = await upsertRes.text();
      console.error('NYLAS CALLBACK: upsert nylas_grants falhou:', upsertRes.status, errText);
      return res.redirect(302, 'https://pallyum.com/app?nylas=error');
    }

    console.log('NYLAS CALLBACK OK | uid=' + uid + ' | provider=' + provider + ' | grant=' + grantId);
    return res.redirect(302, 'https://pallyum.com/app?nylas=connected');

  } catch (e) {
    console.error('NYLAS CALLBACK ERR:', e.message);
    return res.redirect(302, 'https://pallyum.com/app?nylas=error');
  }
}
