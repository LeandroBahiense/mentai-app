import { createHmac, timingSafeEqual } from 'crypto';
import { syncAddOnsAfterRemoval, clearAllPrimary, totalAccounts } from './_lib/plans.js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const sb = (path, opts) => fetch(SUPABASE_URL + '/rest/v1/google_tokens' + path, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(opts && opts.headers) }
  });

  // GET — listar contas (NUNCA retornar tokens)
  if (req.method === 'GET') {
    const r = await sb('?user_id=eq.' + encodeURIComponent(uid) + '&select=id,email,is_primary&order=is_primary.desc', {});
    const data = await r.json();
    return res.status(200).json({ accounts: Array.isArray(data) ? data : [] });
  }

  // PATCH — marcar uma conta como principal (query string ou body: { id })
  if (req.method === 'PATCH') {
    const id = (req.query && req.query.id) || (req.body && req.body.id) || null;
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    // confirma que a conta é do usuário
    const chk = await sb('?user_id=eq.' + encodeURIComponent(uid) + '&id=eq.' + encodeURIComponent(id) + '&select=id', {});
    const found = await chk.json();
    if (!Array.isArray(found) || found.length === 0) return res.status(404).json({ error: 'conta não encontrada' });
    // desmarca a principal nas DUAS tabelas (invariante de principal única global),
    // depois marca a escolhida nesta (google_tokens).
    await clearAllPrimary(uid);
    await sb('?user_id=eq.' + encodeURIComponent(uid) + '&id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ is_primary: true }) });
    return res.status(200).json({ ok: true });
  }

  // DELETE — remover uma conta (query string ou body: { id }) com as regras de principal
  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || (req.body && req.body.id) || null;
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const allR = await sb('?user_id=eq.' + encodeURIComponent(uid) + '&select=id,is_primary', {});
    const all = await allR.json();
    if (!Array.isArray(all)) return res.status(500).json({ error: 'erro ao ler contas' });
    const alvo = all.find(a => a.id === id);
    if (!alvo) return res.status(404).json({ error: 'conta não encontrada' });
    // regra: principal só pode ser removida se for a única conta (CROSS-TABLE: google + nylas)
    if (alvo.is_primary && (await totalAccounts(uid)) > 1) {
      return res.status(409).json({ error: 'principal', message: 'Defina outra conta como principal antes de remover esta.' });
    }
    await sb('?user_id=eq.' + encodeURIComponent(uid) + '&id=eq.' + encodeURIComponent(id), { method: 'DELETE' });

    // Conta removida → cancela add-ons que deixaram de ser necessários (best-effort).
    try { await syncAddOnsAfterRemoval(uid); }
    catch (e) { console.error('[google-accounts] syncAddOnsAfterRemoval falhou (não bloqueia):', e.message); }

    const last = all.length === 1; // sinaliza ao front que era a última
    return res.status(200).json({ ok: true, wasLast: last });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
