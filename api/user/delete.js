/**
 * Pallyum — Soft-delete de conta (LGPD Art.18 IV/VI)
 *
 * POST /api/user/delete
 *
 * Marca a conta do usuário logado para exclusão (account_deleted_at = now).
 * NÃO faz hard-delete — o expurgo D+30 roda no cron daily-usage.
 * Login dentro de 30 dias restaura (zera account_deleted_at) — tratado no front/bootstrap.
 *
 * Identidade: cookie pallyum_session (mesmo esquema do checkout/subscription-status).
 * Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date().toISOString();

  try {
    // 1. Soft-delete: marca account_deleted_at só se ainda nulo.
    //    O filtro account_deleted_at=is.null garante idempotência — uma 2ª chamada
    //    não reseta o relógio de 30 dias. return=representation pra saber se houve transição.
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&account_deleted_at=is.null`,
      {
        method:  'PATCH',
        headers: { ...svcHeaders(), 'Prefer': 'return=representation' },
        body:    JSON.stringify({ account_deleted_at: now }),
      }
    );
    if (!patchRes.ok) {
      console.error('[user/delete] PATCH user_preferences falhou:', patchRes.status);
      return res.status(500).json({ error: 'internal error' });
    }
    const rows = await patchRes.json().catch(() => []);

    // Helper local: grava a auditoria da transição null→timestamp (não-bloqueante).
    const auditTransition = async () => {
      try {
        const auditResp = await fetch(`${SUPABASE_URL}/rest/v1/admin_audit`, {
          method:  'POST',
          headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
          body:    JSON.stringify({
            admin_user_id:  uid,                                       // auto-iniciada: actor = o próprio usuário
            target_user_id: uid,
            action:         'account_deletion_requested',
            old_value:      JSON.stringify({ account_deleted_at: null }),
            new_value:      JSON.stringify({ account_deleted_at: now }),
            created_at:     now,
          }),
        });
        if (!auditResp.ok) {
          console.error('[user/delete] ⚠️  admin_audit INSERT falhou:', auditResp.status);
        }
      } catch (e) {
        console.error('[user/delete] ⚠️  admin_audit INSERT erro:', e.message);
      }
    };

    // Resposta 409 quando não há perfil pra agendar a exclusão (caso (ii) + tail da corrida).
    const noProfile = () =>
      res.status(409).json({
        error:   'no_profile',
        message: 'Não foi possível agendar a exclusão automaticamente. Solicite por Pallyum.app@gmail.com.',
      });

    // ── Caminho feliz: PATCH marcou a linha agora (transição null→timestamp) ──────
    if (Array.isArray(rows) && rows.length > 0) {
      await auditTransition();
      return res.status(200).json({ ok: true });
    }

    // ── PATCH afetou 0 linhas → desambiguar (i) já pendente vs (ii) sem perfil ────
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&select=account_deleted_at`,
      { headers: svcHeaders() }
    );
    if (!getRes.ok) {
      console.error('[user/delete] GET desambiguação falhou:', getRes.status);
      return res.status(500).json({ error: 'internal error' });
    }
    const profileRows = await getRes.json().catch(() => []);
    const profile = Array.isArray(profileRows) ? profileRows[0] : null;

    // (ii) Sem linha de user_preferences → soft-delete NÃO aconteceu. NÃO mentir com 200.
    //      NÃO criamos a linha (pode haver NOT NULL sem default — não chutamos shape).
    if (!profile) {
      console.error('[user/delete] no_profile: sem user_preferences para uid=' + uid);
      return noProfile();
    }

    // (i) Linha já marcada → idempotência, sucesso legítimo. Sem nova transição → sem auditoria.
    if (profile.account_deleted_at) {
      return res.status(200).json({ ok: true, already_pending: true });
    }

    // Corrida rara: linha existe e está null, mas o PATCH inicial pegou 0. Refaz o PATCH 1×.
    const retryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&account_deleted_at=is.null`,
      {
        method:  'PATCH',
        headers: { ...svcHeaders(), 'Prefer': 'return=representation' },
        body:    JSON.stringify({ account_deleted_at: now }),
      }
    );
    if (retryRes.ok) {
      const retryRows = await retryRes.json().catch(() => []);
      if (Array.isArray(retryRows) && retryRows.length > 0) {
        await auditTransition();
        return res.status(200).json({ ok: true });
      }
    } else {
      console.error('[user/delete] PATCH retry falhou:', retryRes.status);
    }

    // Ainda 0 após retry → anomalia não-resolvida (o perfil EXISTE, então não é no_profile).
    // 500 é a resposta honesta.
    console.error('[user/delete] retry não marcou a conta para uid=' + uid);
    return res.status(500).json({ error: 'internal error' });

  } catch (e) {
    console.error('[user/delete] erro inesperado:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
