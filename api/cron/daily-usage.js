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

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
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
  const today = new Date().toISOString().split('T')[0];
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
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const since = sevenDaysAgo.toISOString().split('T')[0];

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

    console.log('[daily-usage] Concluído:', JSON.stringify(results));
    return res.status(200).json({ ok: true, ...results });

  } catch (err) {
    console.error('[daily-usage] Erro geral:', err.message);
    return res.status(500).json({ error: err.message, ...results });
  }
}
