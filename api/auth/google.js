import { createHmac, timingSafeEqual } from 'crypto';

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

export default function handler(req, res) {
  const uidFromCookie = readSession(req);
  const phone  = req.query.phone  || '';
  const userId = uidFromCookie || (req.query.user_id || '');  // web usa cookie; sem cookie (WhatsApp) usa query
  const web    = !!uidFromCookie;
  const state  = signState({ user_id: userId, phone, web, exp: Date.now() + 10 * 60 * 1000 });

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
