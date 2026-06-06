/**
 * Pallyum — Cron diário de uso (23h59)
 * Para cada usuário com mensagens hoje:
 *  1. Calcula daily_avg_7d
 *  2. Atualiza current_cooldown_ms em user_preferences
 *  3. Se avg > 290: alerta no log (painel admin futuro)
 *  4. Se 3 dias consecutivos > 1000 msgs: pending_suspension = true
 * Fonte da verdade: Pallyum-Planos-e-Precos.md seção 9
 */

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET      = process.env.CRON_SECRET; // protege o endpoint
const DIAS_RETENCAO_LAPIDE = 30;  // poda lápides de deleted_notes além disso

function dataHojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}
function dataSPdiasAtras(dias) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date(Date.now() - dias * 86400000));
}

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

async function prunePassedTombstones() {
  try {
    const cutoff = new Date(Date.now() - DIAS_RETENCAO_LAPIDE * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/deleted_notes?deleted_at=lt.' + encodeURIComponent(cutoff),
      { method: 'DELETE', headers: { ...svcHeaders(), 'Prefer': 'count=exact' } }
    );
    const range = res.headers.get('content-range') || '';
    const removed = range.includes('/') ? range.split('/')[1] : '?';
    console.log('[daily-usage] poda deleted_notes | status', res.status, '| removidas:', removed, '| cutoff:', cutoff);
    return { ok: res.ok, removed };
  } catch (e) {
    console.error('[daily-usage] poda deleted_notes erro:', e.message);
    return { ok: false, removed: 0 };
  }
}

// ── Expurgo D+30 de contas excluídas (LGPD) — IRREVERSÍVEL ──────────────────────
// Para cada conta com account_deleted_at > 30d: apaga binários no Storage, rows de files,
// deleta o usuário no auth (CASCADE limpa notes/phone_users/user_preferences) e audita.
// Ordem: Storage → files rows → deleteUser (deleteUser é o "commit" da conta).
async function purgeDeletedAccounts() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Contas vencidas. PostgREST: lt não casa null → contas null/dentro da graça ficam de fora.
    const listRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_preferences?account_deleted_at=lt.' + encodeURIComponent(cutoff) + '&select=user_id,account_deleted_at',
      { headers: svcHeaders() }
    );
    if (!listRes.ok) {
      console.error('[purge] GET contas vencidas falhou:', listRes.status);
      return { ok: false, purged: 0 };
    }
    const contas = await listRes.json().catch(() => []);
    console.log('[purge] contas vencidas:', Array.isArray(contas) ? contas.length : 0);

    let purged = 0;
    for (const conta of (Array.isArray(contas) ? contas : [])) {
      const uid = conta?.user_id;
      const ts  = conta?.account_deleted_at;
      if (!uid) continue;

      try {
        // a. Enumera os objetos da pessoa
        const filesRes = await fetch(
          SUPABASE_URL + '/rest/v1/files?user_id=eq.' + encodeURIComponent(uid) + '&select=path',
          { headers: svcHeaders() }
        );
        const fileRows = filesRes.ok ? await filesRes.json().catch(() => []) : [];

        // b. DELETE de cada objeto no Storage (best-effort; 404/non-ok NÃO é fatal).
        //    path concatenado DIRETO (sem encodeURIComponent — os '/' são separadores de objeto).
        let storageFails = 0;
        for (const f of (Array.isArray(fileRows) ? fileRows : [])) {
          if (!f?.path) continue;
          try {
            const delObj = await fetch(
              SUPABASE_URL + '/storage/v1/object/mentai-files/' + f.path,
              { method: 'DELETE', headers: svcHeaders() }
            );
            if (!delObj.ok) {
              storageFails++;
              console.error('[purge] DELETE objeto falhou (não fatal) uid=' + uid + ' path=' + f.path + ' status=' + delObj.status);
            }
          } catch (eObj) {
            storageFails++;
            console.error('[purge] DELETE objeto erro (não fatal) uid=' + uid + ' path=' + f.path + ':', eObj.message);
          }
        }
        if (storageFails > 0) {
          console.error('[purge] uid=' + uid + ' | falhas de Storage: ' + storageFails + '/' + (Array.isArray(fileRows) ? fileRows.length : 0));
        }

        // c. Apaga as rows de metadados. Non-ok → pula a conta (não deleta o user neste run).
        const delFilesRes = await fetch(
          SUPABASE_URL + '/rest/v1/files?user_id=eq.' + encodeURIComponent(uid),
          { method: 'DELETE', headers: svcHeaders() }
        );
        if (!delFilesRes.ok) {
          console.error('[purge] DELETE files rows falhou uid=' + uid + ' status=' + delFilesRes.status + ' — conta fica pro próximo run');
          continue;
        }

        // d. Deleta o usuário no auth (CASCADE limpa o resto). Non-ok → pula (files já foram).
        const delUserRes = await fetch(
          SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(uid),
          { method: 'DELETE', headers: svcHeaders() }
        );
        if (!delUserRes.ok) {
          console.error('[purge] DELETE auth user falhou uid=' + uid + ' status=' + delUserRes.status + ' — próximo run retenta só o deleteUser');
          continue;
        }

        // e. Auditoria — não-bloqueante.
        try {
          const auditResp = await fetch(SUPABASE_URL + '/rest/v1/admin_audit', {
            method:  'POST',
            headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
            body:    JSON.stringify({
              admin_user_id:  uid,
              target_user_id: uid,
              action:         'account_purged',
              old_value:      JSON.stringify({ account_deleted_at: ts }),
              new_value:      JSON.stringify({ purged: true }),
              created_at:     new Date().toISOString(),
            }),
          });
          if (!auditResp.ok) {
            console.error('[purge] ⚠️  admin_audit INSERT falhou uid=' + uid + ' status=' + auditResp.status);
          }
        } catch (eAudit) {
          console.error('[purge] ⚠️  admin_audit INSERT erro uid=' + uid + ':', eAudit.message);
        }

        purged++;
        console.log('[purge] conta expurgada uid=' + uid);

      } catch (eConta) {
        // Falha de uma conta NÃO derruba o loop nem o cron; fica pro próximo run.
        console.error('[purge] erro ao expurgar uid=' + uid + ':', eConta.message);
      }
    }

    console.log('[purge] concluído | expurgadas:', purged);
    return { ok: true, purged };

  } catch (e) {
    console.error('[purge] erro geral:', e.message);
    return { ok: false, purged: 0 };
  }
}

// Tabela de cooldown por faixa de uso (seção 9.2)
function cooldownFromAvg(avg) {
  if (avg < 100)  return 0;
  if (avg < 150)  return 500;
  if (avg < 200)  return 1500;
  if (avg < 290)  return 3000;
  if (avg < 500)  return 5000;
  if (avg < 800)  return 8000;
  if (avg < 1000) return 15000;
  return 15000; // >= 1000
}

// Busca todos os usuários que tiveram msg_count > 0 hoje
async function getUsersWithActivityToday() {
  const today = dataHojeSP();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/usage_logs?date=eq.${today}&msg_count=gt.0&select=user_id`,
    { headers: svcHeaders() }
  );
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Deduplica user_ids
  return [...new Set(data.map(r => r.user_id))];
}

// Calcula daily_avg_7d para um usuário
async function getDailyAvg7d(userId) {
  const since = dataSPdiasAtras(7);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${encodeURIComponent(userId)}&date=gte.${since}&select=msg_count,date`,
    { headers: svcHeaders() }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // Agrupa por data e soma canais
  const byDate = {};
  for (const row of rows) {
    byDate[row.date] = (byDate[row.date] || 0) + row.msg_count;
  }
  const totals = Object.values(byDate);
  return totals.reduce((a, b) => a + b, 0) / 7;
}

// Conta dias consecutivos com > threshold mensagens (para suspensão)
async function countConsecutiveDaysAbove(userId, threshold) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${encodeURIComponent(userId)}&order=date.desc&limit=10&select=msg_count,date`,
    { headers: svcHeaders() }
  );
  const rows = await res.json();
  if (!Array.isArray(rows)) return 0;

  // Agrupa por data
  const byDate = {};
  for (const row of rows) {
    byDate[row.date] = (byDate[row.date] || 0) + row.msg_count;
  }

  // Conta dias consecutivos mais recentes acima do threshold
  const sortedDates = Object.keys(byDate).sort().reverse();
  let consecutive = 0;
  for (const date of sortedDates) {
    if (byDate[date] > threshold) consecutive++;
    else break;
  }
  return consecutive;
}

// Atualiza user_preferences para um usuário
async function updateUserPrefs(userId, updates) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method:  'PATCH',
      headers: svcHeaders(),
      body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    }
  );
  return res.status >= 200 && res.status < 300;
}

export default async function handler(req, res) {
  // Verificação de segurança: só aceita chamadas autorizadas
  const authHeader = req.headers['authorization'];
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[daily-usage] Cron iniciado:', new Date().toISOString());
  const results = { processed: 0, alerted: 0, suspended: 0, errors: 0 };

  try {
    const userIds = await getUsersWithActivityToday();
    console.log('[daily-usage] Usuários ativos hoje:', userIds.length);

    for (const userId of userIds) {
      try {
        const avg = await getDailyAvg7d(userId);
        const newCooldown = cooldownFromAvg(avg);

        const updates = { current_cooldown_ms: newCooldown };

        // Alerta: avg > 290 msgs/dia
        if (avg > 290) {
          console.warn(`[daily-usage] ALERTA: user=${userId} avg=${avg.toFixed(1)}/dia cooldown=${newCooldown}ms`);
          results.alerted++;
        }

        // Suspensão: 3 dias consecutivos > 1000 msgs
        const consecutiveDays = await countConsecutiveDaysAbove(userId, 1000);
        if (consecutiveDays >= 3) {
          updates.pending_suspension = true;
          console.error(`[daily-usage] SUSPENSÃO PENDENTE: user=${userId} dias=${consecutiveDays} avg=${avg.toFixed(1)}`);
          results.suspended++;
        }

        await updateUserPrefs(userId, updates);
        results.processed++;

      } catch (userErr) {
        console.error(`[daily-usage] Erro para user=${userId}:`, userErr.message);
        results.errors++;
      }
    }

    const podaTombstones = await prunePassedTombstones();
    const expurgoContas  = await purgeDeletedAccounts();
    console.log('[daily-usage] Concluído:', JSON.stringify(results));
    return res.status(200).json({ ok: true, ...results, poda_tombstones: podaTombstones, expurgo_contas: expurgoContas });

  } catch (err) {
    console.error('[daily-usage] Erro geral:', err.message);
    return res.status(500).json({ error: err.message, ...results });
  }
}
