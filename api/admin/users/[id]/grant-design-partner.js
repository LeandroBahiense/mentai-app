/**
 * Pallyum — Admin: conceder plano Design Partner
 *
 * POST /api/admin/users/:id/grant-design-partner
 *
 * Define plano='design_partner' e plano_validade=agora+30 dias.
 * Insere em admin_audit com action='grant_design_partner'.
 * Falha de audit não bloqueia a ação mas aparece no console e retorna
 * audit_logged:false na resposta.
 *
 * Requer sessão de admin válida (cookie pallyum_session + ADMIN_USER_ID).
 * Sem sessão/cookie inválido → 401. Sessão válida mas uid ≠ admin → 403.
 */

import { readSession, isAdmin } from '../../../_lib/adminAuth.js';
import { mirrorPlanCluster } from '../../../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAdmin(uid)) return res.status(403).json({ error: 'Forbidden' });
  const adminUid = uid;

  const targetUserId = (req.query?.id || '').toString().trim();
  if (!targetUserId) {
    return res.status(400).json({ error: 'id obrigatório' });
  }

  // ── Ler estado atual (para o audit log) ─────────────────────────────────────
  let oldPlano = null;
  let oldValidade = null;
  try {
    const oldResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(targetUserId)}&select=plano,plano_validade`,
      { headers: svcHeaders() }
    );
    if (oldResp.ok) {
      const rows = await oldResp.json();
      oldPlano    = rows?.[0]?.plano          || null;
      oldValidade = rows?.[0]?.plano_validade || null;
    }
  } catch (e) {
    console.error('[admin/grant-design-partner] leitura old state falhou:', e.message);
  }

  // ── Calcular validade: agora + 30 dias ───────────────────────────────────────
  const validadeDate = new Date();
  validadeDate.setDate(validadeDate.getDate() + 30);
  const planoValidade = validadeDate.toISOString();

  const patch = {
    plano:          'design_partner',
    plano_validade: planoValidade,
  };

  // ── Aplicar PATCH em user_preferences ───────────────────────────────────────
  const patchResp = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(targetUserId)}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body:    JSON.stringify(patch),
    }
  );
  if (!patchResp.ok) {
    const err = await patchResp.text();
    console.error('[admin/grant-design-partner] PATCH user_preferences falhou:', err);
    return res.status(500).json({ error: 'Erro ao conceder Design Partner' });
  }

  console.log(`[admin/grant-design-partner] OK | admin=${adminUid} | target=${targetUserId} | validade=${planoValidade}`);

  // ── Inserir em admin_audit (defensivo) ───────────────────────────────────────
  let auditLogged = true;
  try {
    const auditResp = await fetch(
      `${SUPABASE_URL}/rest/v1/admin_audit`,
      {
        method:  'POST',
        headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
        body:    JSON.stringify({
          admin_user_id:  adminUid,
          target_user_id: targetUserId,
          action:         'grant_design_partner',
          old_value:      JSON.stringify({ plano: oldPlano, plano_validade: oldValidade }),
          new_value:      JSON.stringify(patch),
          created_at:     new Date().toISOString(),
        }),
      }
    );
    if (!auditResp.ok) {
      const auditErr = await auditResp.text();
      throw new Error('HTTP ' + auditResp.status + ': ' + auditErr);
    }
  } catch (e) {
    auditLogged = false;
    console.error('[admin/grant-design-partner] ⚠️  admin_audit INSERT FALHOU | admin=' + adminUid + ' target=' + targetUserId + ' :', e.message);
  }

  return res.status(200).json({
    ok:             true,
    plano:          'design_partner',
    plano_validade: planoValidade,
    audit_logged:   auditLogged,
  });
}
