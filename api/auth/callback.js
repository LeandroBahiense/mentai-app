import { createHmac, timingSafeEqual } from 'crypto';

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
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const code          = req.query.code;
  const stateParam    = req.query.state || '';

  if (!code) return res.redirect('https://pallyum.com/app?google=error&msg=no_code');

  // ── Verifica e decodifica state assinado (HMAC-SHA256) ──────────────────────
  const st = verifyState(stateParam);
  if (!st) return res.redirect('https://pallyum.com/app?google=error&msg=bad_state');
  let userId = st.user_id || null;
  let phone  = st.phone  || null;
  const cameFromWeb = !!st.web;

  console.log('CALLBACK: userId=' + userId + ' | phone=' + phone + ' | web=' + cameFromWeb);

  try {
    // ── Troca code por tokens ─────────────────────────────────────────────────
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }).toString(),
    });

    const tokenData = await tokenRes.json();
    console.log('GOOGLE TOKEN STATUS:', tokenRes.status, '| has_access_token:', !!tokenData.access_token, '| has_refresh_token:', !!tokenData.refresh_token);

    if (!tokenData.access_token) {
      console.error('CALLBACK: token error:', JSON.stringify(tokenData));
      return res.redirect('https://pallyum.com/app?google=error&msg=token_exchange_failed');
    }

    // ── Busca email do Google ─────────────────────────────────────────────────
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });
    const userInfo = await userRes.json();
    const email = userInfo.email;
    console.log('CALLBACK: google email=' + email);

    // ── Se não temos userId, tenta lookup pelo email no Supabase Auth ─────────
    if (!userId && email) {
      const authRes = await fetch(
        SUPABASE_URL + '/auth/v1/admin/users?email=' + encodeURIComponent(email),
        {
          headers: {
            'apikey':        SERVICE_KEY,
            'Authorization': 'Bearer ' + SERVICE_KEY,
          },
        }
      );
      const authData = await authRes.json();
      userId = authData?.users?.[0]?.id || null;
      console.log('CALLBACK: userId via email lookup=' + userId);
    }

    if (!userId) {
      console.error('CALLBACK: não foi possível resolver userId');
      return res.redirect('https://pallyum.com/app?google=error&msg=user_not_found');
    }

    // ── Busca contas Google já existentes para decidir is_primary ────────────
    const existingRes = await fetch(
      SUPABASE_URL + '/rest/v1/google_tokens?user_id=eq.' + encodeURIComponent(userId) + '&select=email,is_primary',
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY } }
    );
    const existingList = await existingRes.json().catch(() => []);
    const arr       = Array.isArray(existingList) ? existingList : [];
    const jaExiste  = arr.some(r => r.email === email);
    const temAlguma = arr.length > 0;

    // ── UPSERT em google_tokens (by user_id, email) ───────────────────────────
    const upsertBody = {
      user_id:       userId,
      phone:         phone || null,
      email:         email,
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expiry_date:   Date.now() + (tokenData.expires_in || 3600) * 1000,
      updated_at:    new Date().toISOString(),
    };

    if (!jaExiste) {
      upsertBody.is_primary = !temAlguma;  // 1ª conta = principal; adicionais entram como secundárias
    }

    const upsertRes = await fetch(SUPABASE_URL + '/rest/v1/google_tokens?on_conflict=user_id,email', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify(upsertBody),
    });
    const upsertText = await upsertRes.text();
    console.log('GOOGLE_TOKENS UPSERT STATUS:', upsertRes.status, '| body:', upsertText || '(empty)');

    if (upsertRes.status >= 400) {
      console.error('CALLBACK: upsert google_tokens falhou:', upsertText);
      return res.redirect('https://pallyum.com/app?google=error&msg=upsert_failed');
    }

    // ── UPSERT em phone_users (se phone disponível) ───────────────────────────
    if (phone) {
      const puRes = await fetch(SUPABASE_URL + '/rest/v1/phone_users', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SERVICE_KEY,
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'Prefer':        'resolution=merge-duplicates',
        },
        body: JSON.stringify({ phone, user_id: userId }),
      });
      const puText = await puRes.text();
      console.log('PHONE_USERS UPSERT STATUS:', puRes.status, '| body:', puText || '(empty)');
    }

    // ── Redireciona com base na origem ────────────────────────────────────────
    // Veio do app web (tem user_id no state) → feedback na tela
    // Veio do WhatsApp (só phone) → fecha silencioso
    if (userId && cameFromWeb) {
      return res.redirect('https://pallyum.com/app?google=connected');
    } else {
      return res.redirect('https://pallyum.com/app');
    }

  } catch(e) {
    console.error('CALLBACK ERR:', e.message);
    return res.redirect('https://pallyum.com/app?google=error&msg=' + encodeURIComponent(e.message));
  }
}
