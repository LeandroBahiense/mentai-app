/**
 * Pallyum — Admin: listar usuários
 *
 * GET /api/admin/users
 *
 * Retorna JSON com lista de usuários enriquecida:
 *   - email (Supabase auth admin API)
 *   - phone (tabela phone_users)
 *   - plano, plano_validade (user_preferences)
 *   - last_active (proxy: MAX(date) de usage_logs)
 *   - note_count (COUNT de notes)
 *
 * Requer sessão de admin válida (cookie pallyum_session + ADMIN_USER_ID).
 */

import { readSession, isAdmin } from '../_lib/adminAuth.js';

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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAdmin(uid)) return res.status(403).json({ error: 'Forbidden' });
  const adminUid = uid;

  try {
    // ── 1. Buscar todos os registros de user_preferences ───────────────────────
    const prefsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?select=user_id,plano,plano_validade&user_id=not.is.null`,
      { headers: svcHeaders() }
    );
    if (!prefsResp.ok) {
      const err = await prefsResp.text();
      console.error('[admin/users] user_preferences falhou:', err);
      return res.status(500).json({ error: 'Erro ao buscar preferências' });
    }
    const prefs = await prefsResp.json(); // [{ user_id, plano, plano_validade }]

    // ── 2. Buscar telefones (phone_users) ──────────────────────────────────────
    const phoneResp = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_users?select=user_id,phone`,
      { headers: svcHeaders() }
    );
    const phoneRows = phoneResp.ok ? await phoneResp.json() : [];
    const phoneByUser = {};
    for (const row of phoneRows) {
      phoneByUser[row.user_id] = row.phone;
    }

    // ── 3. Buscar last_active por usuário (MAX date de usage_logs) ─────────────
    const logsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_logs?select=user_id,date&order=date.desc`,
      { headers: svcHeaders() }
    );
    const logRows = logsResp.ok ? await logsResp.json() : [];
    const lastActiveByUser = {};
    for (const row of logRows) {
      // Como veio ordenado desc, o primeiro encontrado por user_id é o mais recente
      if (!lastActiveByUser[row.user_id]) {
        lastActiveByUser[row.user_id] = row.date;
      }
    }

    // ── 4. Buscar contagem de notas por usuário ────────────────────────────────
    // Supabase REST não tem GROUP BY nativo; busca só user_id e conta localmente
    const notesResp = await fetch(
      `${SUPABASE_URL}/rest/v1/notes?select=user_id`,
      { headers: svcHeaders() }
    );
    const noteRows = notesResp.ok ? await notesResp.json() : [];
    const noteCountByUser = {};
    for (const row of noteRows) {
      noteCountByUser[row.user_id] = (noteCountByUser[row.user_id] || 0) + 1;
    }

    // ── 5. Buscar email de cada usuário via auth admin API (N+1 aceitável no MVP) ─
    const users = [];
    for (const pref of prefs) {
      const userId = pref.user_id;
      let email = null;
      try {
        const authResp = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
          { headers: svcHeaders() }
        );
        if (authResp.ok) {
          const authData = await authResp.json();
          email = authData?.email || null;
        }
      } catch (e) {
        console.error('[admin/users] auth lookup falhou para userId=' + userId + ':', e.message);
      }

      users.push({
        user_id:       userId,
        email,
        phone:         phoneByUser[userId]    || null,
        plano:         pref.plano             || null,
        plano_validade:pref.plano_validade    || null,
        last_active:   lastActiveByUser[userId] || null,
        note_count:    noteCountByUser[userId]  || 0,
      });
    }

    return res.status(200).json({ users });

  } catch (e) {
    console.error('[admin/users] erro inesperado:', e.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
}
