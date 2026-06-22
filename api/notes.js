import { createClient }              from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'crypto';
import { isPlanActive } from './_lib/plans.js';
import { indexNote } from './_lib/embeddings.js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  if (!uid) {
    return res.status(401).json({ error: 'sessão inválida' });
  }

  // Gate de plano (Etapa 04): GET (leitura) sempre liberado; mutações (POST/DELETE)
  // exigem plano ativo — modo leitura no plano inativo.
  if (req.method !== 'GET' && !(await isPlanActive(uid))) {
    return res.status(402).json({ error: 'plano_inativo' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── GET: lista notas + ids de lápides do usuário ───────────────
  if (req.method === 'GET') {
    const [notesResult, deletedResult] = await Promise.all([
      supabase
        .from('notes')
        .select('*')
        .eq('user_id', uid)
        .order('updated_at', { ascending: false }),
      supabase
        .from('deleted_notes')
        .select('note_id')
        .eq('user_id', uid),
    ]);

    if (notesResult.error) {
      console.error('[api/notes GET] supabase error:', notesResult.error.message);
      return res.status(500).json({ error: notesResult.error.message });
    }

    const deleted = (deletedResult.data || []).map(r => r.note_id);
    return res.status(200).json({ notes: notesResult.data, deleted, user_id: uid });
  }

  // ── POST: upsert de uma nota ────────────────────────────────────
  if (req.method === 'POST') {
    let note = req.body;
    if (typeof note === 'string') {
      try { note = JSON.parse(note); } catch {
        return res.status(400).json({ error: 'invalid JSON body' });
      }
    }

    // Refaz a leitura de sentido só quando a edição é de conteúdo (front sinaliza _reindex).
    const reindex = note._reindex === true;
    if ('_reindex' in note) delete note._reindex;

    // Força user_id pelo cookie — ignora qualquer valor vindo no corpo
    note = { ...note, user_id: uid };

    const { error } = await supabase
      .from('notes')
      .upsert(note, { onConflict: 'id' });

    if (error) {
      console.error('[api/notes POST] supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (reindex) {
      try { await indexNote(note.id, uid, note.title || '', note.content || ''); }
      catch (e) { console.error('[api/notes POST] reindex error:', e.message); }
    }

    return res.status(200).json({ ok: true });
  }

  // ── DELETE: apaga nota do dono + grava lápide ──────────────────
  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) {
      return res.status(400).json({ error: 'id obrigatório' });
    }

    const { error } = await supabase
      .from('notes')
      .delete()
      .eq('id', id)
      .eq('user_id', uid);

    if (error) {
      console.error('[api/notes DELETE] supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // A leitura de sentido morre JUNTO com a nota (LGPD — exclusão completa, sem esperar a faxina das 3h).
    // Best-effort: falha não bloqueia o 200, a faxina diária ainda cobre como rede de segurança.
    const { error: embErr } = await supabase
      .from('note_embeddings')
      .delete()
      .eq('note_id', id)
      .eq('user_id', uid);
    if (embErr) {
      console.error('[api/notes DELETE] limpar leitura de sentido falhou (não crítico):', embErr.message);
    }

    // Lápide: registra exclusão definitiva para sincronizar outros dispositivos.
    // Falha não bloqueia o 200 — a nota já sumiu do banco.
    const { error: tombErr } = await supabase
      .from('deleted_notes')
      .upsert(
        { note_id: id, user_id: uid, deleted_at: new Date().toISOString() },
        { onConflict: 'note_id' }
      );
    if (tombErr) {
      console.error('[api/notes DELETE] tombstone falhou (não crítico):', tombErr.message);
    }

    return res.status(200).json({ ok: true });
  }

  // ── outros métodos ──────────────────────────────────────────────
  return res.status(405).json({ error: 'method not allowed' });
}
