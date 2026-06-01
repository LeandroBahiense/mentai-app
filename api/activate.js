/**
 * Pallyum — WhatsApp self-serve activation
 *
 * POST /api/whatsapp/activate
 * Body JSON: { phone: "+5511999990000" }
 *
 * Identidade: cookie pallyum_session (mesmo esquema do checkout).
 * 1. Valida sessão → 401 sem sessão.
 * 2. Normaliza o telefone pra E.164 (+55…).
 * 3. Gera código de 6 dígitos.
 * 4. Faz upsert em whatsapp_pending (user_id, phone, code, expires_at = now+15min).
 * 5. Retorna { code, waLink } — o front mostra o código e abre o link.
 *
 * NÃO envia mensagem via Twilio; o usuário envia o código por conta própria.
 */

import { createHmac, timingSafeEqual, randomInt } from 'crypto';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_WHATSAPP_FROM      = process.env.TWILIO_WHATSAPP_FROM || '';

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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normaliza um número de telefone pra E.164 (+55…).
 * Remove tudo que não seja dígito ou '+' inicial.
 * Se não começar com '+', assume Brasil (+55).
 */
function normalizeE164(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.trim();
  // Mantém '+' inicial se existir; remove tudo mais que não seja dígito
  let digits = stripped.replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) {
    digits = '+55' + digits;
  }
  // Mínimo: +55 + 10 dígitos (DDD 2 + número 8) = 13 chars
  // Máximo: +55 + 11 dígitos (DDD 2 + celular 9) = 14 chars
  if (digits.length < 12 || digits.length > 15) return null;
  return digits;
}

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Autenticação ─────────────────────────────────────────────────────────────
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // ── Telefone ─────────────────────────────────────────────────────────────────
  const rawPhone = (req.body?.phone || '').toString().trim();
  if (!rawPhone) {
    return res.status(400).json({ error: 'phone obrigatório' });
  }
  const phone = normalizeE164(rawPhone);
  if (!phone) {
    return res.status(400).json({ error: 'Telefone inválido. Use o formato +5511999990000' });
  }

  // ── Gerar código de 6 dígitos único entre pendências ativas ──────────────────
  // Como o match no webhook é só pelo código (sem filtro de phone), ele precisa
  // ser único entre todos os pending não-expirados neste momento.
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // +15 min
  let code = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = String(randomInt(100000, 1000000));
    try {
      const checkResp = await fetch(
        `${SUPABASE_URL}/rest/v1/whatsapp_pending?code=eq.${encodeURIComponent(candidate)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=code`,
        { headers: svcHeaders() }
      );
      if (checkResp.ok) {
        const existing = await checkResp.json();
        if (existing.length === 0) { code = candidate; break; }
        // Colisão (raríssima): tenta novo candidato
        console.log('[whatsapp/activate] colisão de código na tentativa ' + attempt + ', gerando novo…');
      } else {
        // Falha na consulta: usa o candidato mesmo assim (1/900.000 chance de colisão)
        code = candidate; break;
      }
    } catch (e) {
      code = candidate; break; // idem
    }
  }
  if (!code) {
    console.error('[whatsapp/activate] não conseguiu gerar código único após 10 tentativas');
    return res.status(500).json({ error: 'Erro ao gerar código de ativação. Tente em instantes.' });
  }

  // ── Upsert em whatsapp_pending ────────────────────────────────────────────────
  const upsertResp = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_pending`,
    {
      method:  'POST',
      headers: {
        ...svcHeaders(),
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        phone,
        user_id:    userId,
        code,
        expires_at: expiresAt,
      }),
    }
  );

  if (!upsertResp.ok) {
    const err = await upsertResp.text();
    console.error('[whatsapp/activate] upsert whatsapp_pending falhou:', err);
    return res.status(500).json({ error: 'Erro ao gerar código de ativação' });
  }

  console.log(`[whatsapp/activate] código gerado | userId=${userId} | phone=${phone} | expires=${expiresAt}`);

  // ── Montar waLink ─────────────────────────────────────────────────────────────
  // TWILIO_WHATSAPP_FROM pode vir como "whatsapp:+14155238886" ou "+14155238886"
  const twilioDigits = TWILIO_WHATSAPP_FROM.replace(/\D/g, '');
  const waLink = twilioDigits
    ? 'https://wa.me/' + twilioDigits + '?text=' + encodeURIComponent(code)
    : null;

  return res.status(200).json({ code, waLink });
}
