/**
 * Pallyum — Cron diário (Etapa 04.3b + 04.4b)
 * Passo 1: email de "acesso pausado" no D+0 — quem venceu nas últimas 48h, conta
 *          não-excluída, ainda não avisado neste ciclo (aviso_d0_validade != plano_validade).
 * Passo 2: limpeza de add-ons (e-mails extras) de planos VENCIDOS — evita add-on
 *          órfão cobrando depois da expiração.
 */
import { sendPlanoExpiradoByUserId } from '../_lib/email.js';
import { cancelAllAddOns } from '../_lib/plans.js';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET      = process.env.CRON_SECRET;

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const agora = new Date();
  const nowIso = agora.toISOString();
  const doisDiasAtras = new Date(agora.getTime() - 2 * 86400000).toISOString();

  let enviados = 0, falhas = 0;
  try {
    const url = SUPABASE_URL + '/rest/v1/user_preferences'
      + '?plano_validade=lt.' + encodeURIComponent(nowIso)
      + '&plano_validade=gt.' + encodeURIComponent(doisDiasAtras)
      + '&account_deleted_at=is.null'
      + '&select=user_id,plano_validade,aviso_d0_validade';
    const r = await fetch(url, { headers: svcHeaders() });
    const rows = r.ok ? await r.json().catch(() => []) : [];

    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (row.aviso_d0_validade && row.aviso_d0_validade === row.plano_validade) continue; // já avisou este ciclo
      try {
        await sendPlanoExpiradoByUserId({ userId: row.user_id });
        await fetch(
          SUPABASE_URL + '/rest/v1/user_preferences?user_id=eq.' + encodeURIComponent(row.user_id),
          { method: 'PATCH', headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
            body: JSON.stringify({ aviso_d0_validade: row.plano_validade }) }
        );
        enviados++;
      } catch (e) {
        falhas++;
        console.error('[plan-expiry-email] falha uid=' + row.user_id + ':', e.message);
      }
    }
  } catch (e) {
    console.error('[plan-expiry-email] erro geral:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }

  // ── Passo 2 (Etapa 04.4b): cancela add-ons de quem está com plano VENCIDO ──────
  // Sem janela de 48h: pega qualquer plano vencido que ainda tenha add-on ativo,
  // evitando add-on órfão cobrando depois da expiração. Idempotente: cancelado sai
  // de status='active' e não reaparece. Reusa cancelAllAddOns (mecânica provada).
  let addonsLimpos = 0;
  try {
    const ar = await fetch(
      SUPABASE_URL + '/rest/v1/account_addons?status=eq.active&select=user_id',
      { headers: svcHeaders() }
    );
    const addonRows = ar.ok ? await ar.json().catch(() => []) : [];
    const uids = [...new Set((Array.isArray(addonRows) ? addonRows : []).map(x => x.user_id).filter(Boolean))];

    for (const uid of uids) {
      try {
        const pr = await fetch(
          SUPABASE_URL + '/rest/v1/user_preferences?user_id=eq.' + encodeURIComponent(uid)
            + '&plano_validade=lt.' + encodeURIComponent(nowIso)
            + '&account_deleted_at=is.null'
            + '&select=user_id',
          { headers: svcHeaders() }
        );
        const expired = pr.ok ? await pr.json().catch(() => []) : [];
        if (Array.isArray(expired) && expired.length > 0) {
          addonsLimpos += await cancelAllAddOns(uid);
        }
      } catch (e) {
        console.error('[plan-expiry-email] limpeza add-on falhou uid=' + uid + ':', e.message);
      }
    }
  } catch (e) {
    console.error('[plan-expiry-email] erro no passo de add-on:', e.message);
  }

  console.log('[plan-expiry-email] enviados=' + enviados + ' falhas=' + falhas + ' addonsLimpos=' + addonsLimpos);
  return res.status(200).json({ ok: true, enviados, falhas, addonsLimpos });
}
