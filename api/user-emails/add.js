/**
 * Pallyum — Adicionar email secundário (com confirmação)
 *
 * POST /api/user-emails/add
 * Body: { email: string, label?: string }
 *
 * Fluxo:
 * 1. Autentica via cookie HMAC.
 * 2. Lazy cleanup: deleta tokens expirados do user.
 * 3. Valida email (formato, não-duplicado, não é o principal do user).
 * 4. Gera token UUID e cria registro pendente.
 * 5. Dispara email de confirmação via Resend.
 *
 * Política: NÃO usar Supabase SDK do frontend pra adicionar email; sempre passar
 * por essa rota pra garantir geração de token + envio de email atomicamente.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { sendConfirmacaoEmailSecundario } from '../_lib/email.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_HOURS = 24;
const COOLDOWN_ADD_MS = 20 * 1000;

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

async function getPrimaryEmail(userId) {
  const resp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    { headers: svcHeaders() }
  );
  if (!resp.ok) {
    throw new Error('Falha buscando email principal: ' + await resp.text());
  }
  const data = await resp.json();
  return data?.email || null;
}

async function cleanupExpiredTokens(userId) {
  // Lazy cleanup: remove registros pendentes (confirmed_at IS NULL) cujo token já expirou
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?user_id=eq.${encodeURIComponent(userId)}&confirmed_at=is.null&confirmation_token_expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      { method: 'DELETE', headers: svcHeaders() }
    );
  } catch (e) {
    // Não-bloqueante; só loga
    console.error('[user-emails/add] cleanup falhou:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) {
    return res.status(401).json({ error: 'sessão inválida' });
  }

  const { email, label } = req.body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email obrigatório' });
  }
  const emailNormalizado = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(emailNormalizado)) {
    return res.status(400).json({ error: 'formato de email inválido' });
  }

  // Lazy cleanup
  await cleanupExpiredTokens(uid);

  // Verifica se é o email principal do próprio user
  let primaryEmail;
  try {
    primaryEmail = await getPrimaryEmail(uid);
  } catch (e) {
    console.error('[user-emails/add]', e.message);
    return res.status(500).json({ error: 'falha ao consultar conta' });
  }
  if (primaryEmail && primaryEmail.toLowerCase() === emailNormalizado) {
    return res.status(400).json({ error: 'este já é o seu e-mail principal' });
  }

  // Verifica se o mesmo user já tem esse email cadastrado (confirmado ou pendente)
  try {
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?user_id=eq.${encodeURIComponent(uid)}&email=eq.${encodeURIComponent(emailNormalizado)}&select=id,confirmed_at`,
      { headers: svcHeaders() }
    );
    const rows = await checkRes.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const existing = rows[0];
      if (existing.confirmed_at) {
        return res.status(400).json({ error: 'este e-mail já está confirmado na sua conta' });
      } else {
        return res.status(400).json({ error: 'este e-mail já foi adicionado e está aguardando confirmação' });
      }
    }
  } catch (e) {
    console.error('[user-emails/add] check duplicado falhou:', e.message);
    return res.status(500).json({ error: 'falha ao consultar emails existentes' });
  }

  // Rate limit: cooldown por usuário — verifica envio mais recente de qualquer email do user
  try {
    const rlRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?user_id=eq.${encodeURIComponent(uid)}&last_email_sent_at=not.is.null&select=last_email_sent_at&order=last_email_sent_at.desc&limit=1`,
      { headers: svcHeaders() }
    );
    const rlRows = await rlRes.json();
    const last = Array.isArray(rlRows) && rlRows.length > 0 ? rlRows[0].last_email_sent_at : null;
    if (last) {
      const elapsed = Date.now() - new Date(last).getTime();
      if (elapsed < COOLDOWN_ADD_MS) {
        const retryAfter = Math.ceil((COOLDOWN_ADD_MS - elapsed) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Aguarde alguns segundos antes de reenviar.', retryAfter });
      }
    }
  } catch (e) {
    console.error('[user-emails/add] rate limit check falhou (não bloqueante):', e.message);
  }

  // Gera token e cria registro pendente
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

  let insertedId;
  try {
    const insertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails`,
      {
        method: 'POST',
        headers: { ...svcHeaders(), 'Prefer': 'return=representation' },
        body: JSON.stringify({
          user_id:                        uid,
          email:                          emailNormalizado,
          label:                          (typeof label === 'string' ? label.trim().slice(0, 80) : null) || null,
          is_primary:                     false,
          confirmation_token:             token,
          confirmation_token_expires_at:  expiresAt,
          last_email_sent_at:             new Date().toISOString(),
        }),
      }
    );
    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('[user-emails/add] INSERT falhou:', err);
      return res.status(500).json({ error: 'falha ao registrar email' });
    }
    const data = await insertRes.json();
    insertedId = Array.isArray(data) ? data[0]?.id : data?.id;
  } catch (e) {
    console.error('[user-emails/add] INSERT erro:', e.message);
    return res.status(500).json({ error: 'falha ao registrar email' });
  }

  // Dispara email de confirmação
  const confirmationUrl = `https://www.pallyum.com/api/user-emails/confirm?token=${encodeURIComponent(token)}`;
  try {
    await sendConfirmacaoEmailSecundario({
      toEmail:      emailNormalizado,
      confirmationUrl,
      primaryEmail: primaryEmail || 'um usuário do Pallyum',
    });
  } catch (e) {
    // Email falhou — rollback do registro pra evitar lixo
    console.error('[user-emails/add] envio de email falhou:', e.message);
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_emails?id=eq.${encodeURIComponent(insertedId)}`,
        { method: 'DELETE', headers: svcHeaders() }
      );
    } catch (rollbackErr) {
      console.error('[user-emails/add] ROLLBACK falhou:', rollbackErr.message);
    }
    return res.status(502).json({ error: 'falha ao enviar email de confirmação. Tente novamente.' });
  }

  return res.status(200).json({
    ok: true,
    emailId: insertedId,
    status: 'pending',
    expiresAt,
    message: 'E-mail de confirmação enviado. Tem 24h para confirmar.',
  });
}
