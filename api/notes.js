import { createClient } from '@supabase/supabase-js';
import { readSession }  from './_lib/session.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const uid = readSession(req);
  if (!uid) {
    return res.status(401).json({ error: 'sessão inválida' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── GET: lista notas do usuário ─────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', uid)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[api/notes GET] supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  }

  // ── POST: upsert de uma nota ────────────────────────────────────
  if (req.method === 'POST') {
    let note = req.body;
    if (typeof note === 'string') {
      try { note = JSON.parse(note); } catch {
        return res.status(400).json({ error: 'invalid JSON body' });
      }
    }

    // Força user_id pelo cookie — ignora qualquer valor vindo no corpo
    note = { ...note, user_id: uid };

    const { error } = await supabase
      .from('notes')
      .upsert(note, { onConflict: 'id' });

    if (error) {
      console.error('[api/notes POST] supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true });
  }

  // ── outros métodos ──────────────────────────────────────────────
  return res.status(405).json({ error: 'method not allowed' });
}
