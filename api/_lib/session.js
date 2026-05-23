import { createClient } from '@supabase/supabase-js';
import { createHmac }    from 'node:crypto';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SESSION_SECRET    = process.env.SESSION_SECRET;

function toBase64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'sem token' });
  }

  // Validar token com Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) {
    return res.status(401).json({ error: 'token inválido' });
  }
  const uid = data.user.id;

  // Montar cookie assinado
  const payload    = { uid, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 };
  const payloadB64 = toBase64url(JSON.stringify(payload));
  const sig        = createHmac('sha256', SESSION_SECRET)
                       .update(payloadB64)
                       .digest();
  const sigB64     = toBase64url(sig);
  const cookieVal  = payloadB64 + '.' + sigB64;

  res.setHeader(
    'Set-Cookie',
    `pallyum_session=${cookieVal}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
  );
  return res.status(200).json({ ok: true });
}
