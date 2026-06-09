/**
 * Pallyum — gerência de contas Nylas (listar / remover). Espelha google-accounts.js.
 * Cookie pallyum_session → uid; 401 sem sessão. Tudo via service role.
 * NUNCA retorna grant_id ao browser. Sem "tornar principal" (Nylas não roteia escrita).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { revokeGrant } from './_lib/nylas.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

export default async function handler(req, res) {
  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const sb = (path, opts) => fetch(SUPABASE_URL + '/rest/v1/nylas_grants' + path, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(opts && opts.headers) }
  });

  // GET — listar grants (NUNCA retornar grant_id)
  if (req.method === 'GET') {
    const r = await sb('?user_id=eq.' + encodeURIComponent(uid) + '&select=id,email,provider,is_primary,status&order=created_at', {});
    const data = await r.json();
    return res.status(200).json({ accounts: Array.isArray(data) ? data : [] });
  }

  // DELETE (?id=) — remove um grant: valida posse → revoga na Nylas (best-effort) → apaga linha
  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || (req.body && req.body.id) || null;
    if (!id) return res.status(400).json({ error: 'id obrigatório' });

    // confirma que o grant é do usuário e lê o grant_id (server-side)
    const chk = await sb('?user_id=eq.' + encodeURIComponent(uid) + '&id=eq.' + encodeURIComponent(id) + '&select=id,grant_id', {});
    const found = await chk.json();
    if (!Array.isArray(found) || found.length === 0) return res.status(404).json({ error: 'conta não encontrada' });

    const grantId = found[0].grant_id;
    if (grantId) {
      const ok = await revokeGrant(grantId);
      if (!ok) console.error('[nylas-accounts] revokeGrant falhou (segue com delete local):', id);
    }

    await sb('?user_id=eq.' + encodeURIComponent(uid) + '&id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
