/**
 * Pallyum — Admin: editar plano de um usuário
 *
 * PATCH /api/admin/users/:id
 * Body JSON: { plano?, plano_validade? }
 *
 * - plano: deve estar em { essencial, pro, ultra, design_partner }
 * - plano_validade: string ISO 8601 ou null (sem validade)
 *
 * Ambos os campos são opcionais; ao menos um deve ser enviado.
 * Insere em admin_audit de forma defensiva; falha de audit não bloqueia a ação
 * mas aparece no console e retorna audit_logged:false na resposta.
 *
 * Requer sessão de admin válida (cookie pallyum_session + ADMIN_USER_ID).
 * Sem sessão/cookie inválido → 401. Sessão válida mas uid ≠ admin → 403.
 */

import { readSession, isAdmin } from '../../_lib/adminAuth.js';
import { mirrorPlanCluster } from '../../_lib/plans.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_PLANOS = new Set(['essencial', 'pro', 'ultra', 'design_partner']);

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'PATCH') {
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

  const { plano, plano_validade } = req.body || {};

  // Validação: ao menos um campo
  const hasPlano    = plano    !== undefined;
  const hasValidade = plano_validade !== undefined;
  if (!hasPlano && !hasValidade) {
    return res.status(400).json({ error: 'Informe plano e/ou plano_validade' });
  }

  // Validação: plano deve ser válido se fornecido
  if (hasPlano && !VALID_PLANOS.has(plano)) {
    return res.status(400).json({
      error: 'plano inválido. Valores aceitos: essencial, pro, ultra, design_partner',
    });
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
    console.error('[admin/users/[id]] leitura old state falhou:', e.message);
  }

  // ── Montar patch ─────────────────────────────────────────────────────────────
  const patch = {};
  if (hasPlano)    patch.plano           = plano;
  if (hasValidade) patch.plano_validade  = plano_validade || null;

  // ── Aplicar PATCH em user_preferences ───────────────────────────────────────
  const patchResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(targetUserId)}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body:    JSON.stringify(patch),
    }
  );
  if (!patchResp.ok) {
    const err = await patchResp.text();
    console.error('[admin/users/[id]] PATCH user_preferences falhou:', err);
    return res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }

  // Dual-write (04.5/F2): espelha o mesmo patch do cluster em subscriptions (aditivo, best-effort).
  await mirrorPlanCluster(targetUserId, patch);

  console.log(`[admin/users/[id]] OK | admin=${adminUid} | target=${targetUserId} | patch=${JSON.stringify(patch)}`);

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
          action:         'update_plan',
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
    console.error('[admin/users/[id]] ⚠️  admin_audit INSERT FALHOU | admin=' + adminUid + ' target=' + targetUserId + ' :', e.message);
  }

  return res.status(200).json({ ok: true, updated: patch, audit_logged: auditLogged });
}
