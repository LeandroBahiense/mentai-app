import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOOR = 0.30;          // piso de "parecença" (definido empiricamente)
const TOP_K = 8;             // candidatos a buscar antes de filtrar
const MAX_SUGGESTIONS = 3;   // teto de sugestões mostradas

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'sessão inválida' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const noteId = req.query && req.query.id;
  if (!noteId) return res.status(400).json({ error: 'id obrigatório' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Candidatos por similaridade da impressão (achador no banco).
  const { data: matches, error: mErr } = await supabase.rpc('match_notes_for_note', {
    p_note_id: noteId,
    p_user_id: uid,
    p_top_k:   TOP_K,
  });
  if (mErr) {
    console.error('[suggest-connections] rpc error:', mErr.message);
    return res.status(500).json({ error: mErr.message });
  }

  // 2. Conexões já existentes da nota — para não sugerir o que já está ligado.
  const { data: noteRow } = await supabase
    .from('notes')
    .select('connections')
    .eq('id', noteId)
    .eq('user_id', uid)
    .maybeSingle();
  const already = new Set(Array.isArray(noteRow?.connections) ? noteRow.connections : []);

  // 3. Filtra (auto, já conectadas, piso), dedup por título, teto de 3.
  const seenTitles = new Set();
  const suggestions = [];
  for (const m of (matches || [])) {
    if (m.note_id === noteId) continue;
    if (already.has(m.note_id)) continue;
    if ((m.similarity ?? 0) < FLOOR) continue;
    const key = (m.title || '').trim().toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    suggestions.push({ id: m.note_id, title: m.title, similarity: m.similarity });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }

  return res.status(200).json({ suggestions });
}
