/**
 * Pallyum — Cron diário: email de "acesso pausado" no D+0 (Etapa 04.3b)
 * Acha quem venceu nas últimas 48h, conta não-excluída, e ainda não avisado neste
 * ciclo (aviso_d0_validade != plano_validade). Envia o email e marca o ciclo.
 */
import { sendPlanoExpiradoByUserId } from '../_lib/email.js';

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

  console.log('[plan-expiry-email] enviados=' + enviados + ' falhas=' + falhas);
  return res.status(200).json({ ok: true, enviados, falhas });
}
