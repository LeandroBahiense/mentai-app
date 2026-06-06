/**
 * Pallyum — Opt-in do briefing matinal no WhatsApp (base de consentimento LGPD)
 *
 * POST /api/user/briefing-optin
 * Body JSON: { enabled: boolean }
 *
 * enabled=true  → grava consentimento em user_consents (doc_type='briefing') e,
 *                 SÓ se o consent gravou, seta user_preferences.briefing_optin=true.
 * enabled=false → revoga: seta briefing_optin=false (não grava consent; cron para de enviar).
 *
 * Identidade: cookie pallyum_session. Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Versão do consentimento do briefing. Atualizar quando o texto do opt-in mudar.
const BRIEFING_CONSENT_VERSION = '2026-06-06';

// Texto literal mostrado ao usuário no toggle (prova LGPD) — igual ao do app.html.
const BRIEFING_CONSENT_TEXT = 'Ao ativar, você concorda em receber uma mensagem do Pallyum no WhatsApp todas as manhãs, no horário escolhido, com o resumo do seu dia. Você pode desativar quando quiser, aqui nas Configurações.';

// ── Helpers de sessão — CÓPIA LITERAL de api/asaas/checkout.js ───────────────

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

// IP server-side (não-forjável) — mesma lógica do api/signup.js
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || null;
}

async function setOptin(uid, value) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body:    JSON.stringify({ briefing_optin: value, updated_at: new Date().toISOString() }),
    }
  );
  return res.ok;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  const enabled = body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) obrigatório' });
  }

  try {
    if (enabled) {
      // 1º grava a prova de consentimento — shape espelhado do api/signup.js
      const ip        = getClientIp(req);
      const userAgent = req.headers['user-agent'] || null;
      const consentResp = await fetch(`${SUPABASE_URL}/rest/v1/user_consents`, {
        method:  'POST',
        headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
        body:    JSON.stringify({
          user_id:     uid,
          doc_type:    'briefing',
          doc_version: BRIEFING_CONSENT_VERSION,
          ip,
          user_agent:  userAgent,
          text_shown:  BRIEFING_CONSENT_TEXT,
        }),
      });
      if (!consentResp.ok) {
        // flag=true só pode existir com consentimento gravado → não seta o flag.
        console.error('[briefing-optin] INSERT user_consents falhou:', consentResp.status, await consentResp.text().catch(() => ''));
        return res.status(500).json({ error: 'internal error' });
      }

      // 2º só agora seta o opt-in
      if (!(await setOptin(uid, true))) {
        console.error('[briefing-optin] PATCH briefing_optin=true falhou para uid=' + uid);
        return res.status(500).json({ error: 'internal error' });
      }
      return res.status(200).json({ ok: true });
    }

    // enabled === false → revogação (não grava consent)
    if (!(await setOptin(uid, false))) {
      console.error('[briefing-optin] PATCH briefing_optin=false falhou para uid=' + uid);
      return res.status(500).json({ error: 'internal error' });
    }
    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error('[briefing-optin] erro inesperado:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
