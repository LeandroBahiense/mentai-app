/**
 * Pallyum — Reenviar email de confirmação
 *
 * POST /api/user-emails/resend-confirmation
 * Body: { emailId: string }
 *
 * Regenera token (extends 24h) e dispara novo email. Só funciona em registros
 * pendentes (confirmed_at IS NULL) do próprio user autenticado.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { sendConfirmacaoEmailSecundario } from '../_lib/email.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TOKEN_TTL_HOURS = 24;
const COOLDOWN_RESEND_MS = 60 * 1000;

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
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.email || null;
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

  const { emailId } = req.body || {};
  if (!emailId || typeof emailId !== 'string') {
    return res.status(400).json({ error: 'emailId obrigatório' });
  }

  // Busca o registro
  let row;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?id=eq.${encodeURIComponent(emailId)}&user_id=eq.${encodeURIComponent(uid)}&select=email,confirmed_at,last_email_sent_at`,
      { headers: svcHeaders() }
    );
    const rows = await resp.json();
    row = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('[user-emails/resend] consulta falhou:', e.message);
    return res.status(500).json({ error: 'falha ao consultar registro' });
  }

  if (!row) {
    return res.status(404).json({ error: 'registro não encontrado' });
  }
  if (row.confirmed_at) {
    return res.status(400).json({ error: 'este email já está confirmado' });
  }

  // Rate limit: cooldown por email/linha
  if (row.last_email_sent_at) {
    const elapsed = Date.now() - new Date(row.last_email_sent_at).getTime();
    if (elapsed < COOLDOWN_RESEND_MS) {
      const retryAfter = Math.ceil((COOLDOWN_RESEND_MS - elapsed) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Aguarde alguns segundos antes de reenviar.', retryAfter });
    }
  }

  // Regenera token
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

  try {
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?id=eq.${encodeURIComponent(emailId)}`,
      {
        method: 'PATCH',
        headers: svcHeaders(),
        body: JSON.stringify({
          confirmation_token:            token,
          confirmation_token_expires_at: expiresAt,
          last_email_sent_at:            new Date().toISOString(),
        }),
      }
    );
    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error('[user-emails/resend] UPDATE falhou:', err);
      return res.status(500).json({ error: 'falha ao regenerar token' });
    }
  } catch (e) {
    console.error('[user-emails/resend] UPDATE erro:', e.message);
    return res.status(500).json({ error: 'falha ao regenerar token' });
  }

  // Envia email
  const primaryEmail = await getPrimaryEmail(uid);
  const confirmationUrl = `https://www.pallyum.com/api/user-emails/confirm?token=${encodeURIComponent(token)}`;
  try {
    await sendConfirmacaoEmailSecundario({
      toEmail:      row.email,
      confirmationUrl,
      primaryEmail: primaryEmail || 'um usuário do Pallyum',
    });
  } catch (e) {
    console.error('[user-emails/resend] email falhou:', e.message);
    return res.status(502).json({ error: 'falha ao enviar email de confirmação' });
  }

  return res.status(200).json({
    ok: true,
    expiresAt,
    message: 'Novo e-mail de confirmação enviado.',
  });
}
