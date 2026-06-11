/**
 * Pallyum — Estado da conta + restauração dentro da graça (LGPD)
 *
 * POST /api/user/account-status
 *
 * Resolve o estado de exclusão da conta do usuário logado e, se houver pedido de
 * exclusão DENTRO dos 30 dias, restaura (zera account_deleted_at) atomicamente.
 * O front chama no bootstrap e reage ao status.
 *
 * Respostas (200):
 *   { status: 'active' }         → sem pedido de exclusão
 *   { status: 'restored' }       → havia pedido < 30d; restaurado agora
 *   { status: 'pending_purge' }  → pedido >= 30d; aguardando expurgo D+30 (não restaura)
 *
 * Identidade: cookie pallyum_session. Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { isPlanActive } from '../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

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

  // Sinal de plano ativo pro front entrar em modo leitura no boot (Etapa 04.2).
  // Mesma lógica do gate (bypass admin + fail-open) — fonte única.
  const planoAtivo = await isPlanActive(uid);

  try {
    // 1. Lê o estado de exclusão da conta
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&select=account_deleted_at,plano_validade`,
      { headers: svcHeaders() }
    );
    if (!getRes.ok) {
      console.error('[user/account-status] GET user_preferences falhou:', getRes.status);
      return res.status(500).json({ error: 'internal error' });
    }
    const rows    = await getRes.json().catch(() => []);
    const profile = Array.isArray(rows) ? rows[0] : null;
    const deletedAt = profile?.account_deleted_at || null;
    // Dias até vencer (pro popup de renovação, Etapa 04.3a). null = sem validade/já vencido.
    const planoValidade = profile?.plano_validade || null;
    let diasParaVencer = null;
    if (planoValidade) {
      const ms = new Date(planoValidade).getTime() - Date.now();
      if (Number.isFinite(ms) && ms > 0) diasParaVencer = Math.ceil(ms / 86400000);
    }

    // Sem linha OU sem pedido de exclusão → conta ativa
    if (!deletedAt) {
      return res.status(200).json({ status: 'active', planoAtivo, diasParaVencer, planoValidade });
    }

    // 2. Há pedido de exclusão — dentro da graça?
    const idadeMs = Date.now() - new Date(deletedAt).getTime();
    const dentroDaGraca = idadeMs < GRACE_MS;

    // >= 30 dias → não restaura; aguarda expurgo D+30
    if (!dentroDaGraca) {
      return res.status(200).json({ status: 'pending_purge' });
    }

    // < 30 dias → RESTAURA (zera account_deleted_at). Filtro not.is.null evita double-restore.
    // return=representation pra auditar SÓ quando houve transição real (consistente com delete.js).
    const now = new Date().toISOString();
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(uid)}&account_deleted_at=not.is.null`,
      {
        method:  'PATCH',
        headers: { ...svcHeaders(), 'Prefer': 'return=representation' },
        body:    JSON.stringify({ account_deleted_at: null }),
      }
    );
    if (!patchRes.ok) {
      console.error('[user/account-status] PATCH restauração falhou:', patchRes.status);
      return res.status(500).json({ error: 'internal error' });
    }
    const rows = await patchRes.json().catch(() => []);
    const transitioned = Array.isArray(rows) && rows.length > 0;

    // Trilha de auditoria — só quando houve transição real (rows>0). Se a restauração já
    // ocorreu por concorrência (0 linhas), a outra requisição já auditou. Não-bloqueante.
    if (transitioned) {
      try {
        const auditResp = await fetch(`${SUPABASE_URL}/rest/v1/admin_audit`, {
          method:  'POST',
          headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
          body:    JSON.stringify({
            admin_user_id:  uid,                                   // auto-iniciada: actor = o próprio usuário
            target_user_id: uid,
            action:         'account_deletion_canceled',
            old_value:      JSON.stringify({ account_deleted_at: deletedAt }),
            new_value:      JSON.stringify({ account_deleted_at: null }),
            created_at:     now,
          }),
        });
        if (!auditResp.ok) {
          console.error('[user/account-status] ⚠️  admin_audit INSERT falhou:', auditResp.status);
        }
      } catch (e) {
        console.error('[user/account-status] ⚠️  admin_audit INSERT erro:', e.message);
      }
    }

    // Conta está ativa de qualquer forma (transição agora ou já restaurada por concorrência).
    return res.status(200).json({ status: 'restored', planoAtivo, diasParaVencer, planoValidade });

  } catch (e) {
    console.error('[user/account-status] erro inesperado:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
