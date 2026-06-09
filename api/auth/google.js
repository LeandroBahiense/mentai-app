import { createHmac, timingSafeEqual } from 'crypto';
import { checkAccountLimit } from '../_lib/plans.js';

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

function signState(payload) {
  const b64 = toBase64url(JSON.stringify(payload));
  const sig = toBase64url(createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest());
  return b64 + '.' + sig;
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
  const uidFromCookie = readSession(req);
  let userId = '', phone = '', web = false;
  if (uidFromCookie) {
    userId = uidFromCookie;
    phone  = req.query.phone || '';
    web    = true;
  } else if (req.query.token) {
    const t = verifyState(req.query.token);
    if (!t || !t.phone) return res.redirect('https://pallyum.com/app?google=error&msg=bad_link');
    phone = t.phone;
    web   = false;
  } else {
    return res.redirect('https://pallyum.com/app?google=error&msg=no_auth');
  }

  // Gate de limite (simetria com nylas-connect). Só quando há uid (fluxo web);
  // no fluxo por telefone (WhatsApp) não há uid p/ contar — segue normal.
  if (userId) {
    try {
      const limit = await checkAccountLimit(userId);
      if (limit && limit.atLimit) {
        console.log('GOOGLE CONNECT: limite de contas atingido | uid=' + userId + ' | ' + limit.used + '/' + limit.max);
        return res.redirect('https://pallyum.com/app?google=limit');
      }
    } catch (e) {
      console.error('GOOGLE CONNECT: checkAccountLimit falhou (segue):', e.message);
    }
  }

  const state = signState({ user_id: userId, phone, web, exp: Date.now() + 10 * 60 * 1000 });

  const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         scopes,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });

  return res.redirect(
    'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
  );
}
