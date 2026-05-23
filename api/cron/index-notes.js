const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

import { indexNote } from '../_lib/embeddings.js';

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

// ─── Buscar todas as notas ativas ────────────────────────────────────────────

async function getActiveNotes() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?in_trash=is.false&select=id,user_id,title,content,updated_at',
    { headers: svcHeaders() }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error('Falha ao buscar notas: ' + res.status + ' ' + err);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ─── Buscar todos os embeddings existentes ───────────────────────────────────

async function getAllEmbeddings() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/note_embeddings?select=note_id,updated_at',
    { headers: svcHeaders() }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error('Falha ao buscar embeddings: ' + res.status + ' ' + err);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return new Map();
  return new Map(data.map(e => [e.note_id, e.updated_at]));
}

// ─── Deletar embedding órfão ─────────────────────────────────────────────────

async function deleteEmbedding(noteId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/note_embeddings?note_id=eq.' + encodeURIComponent(noteId),
    { method: 'DELETE', headers: svcHeaders() }
  );
  return res.ok;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) {
    console.warn('INDEX-NOTES: unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('INDEX-NOTES CRON: start', new Date().toISOString());

  // 1. Buscar notas ativas
  let notes;
  try {
    notes = await getActiveNotes();
  } catch (e) {
    console.error('INDEX-NOTES: erro ao buscar notas:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log('INDEX-NOTES: notas ativas encontradas:', notes.length);

  // 2. Buscar embeddings existentes → Map note_id -> updated_at
  let embeddingMap;
  try {
    embeddingMap = await getAllEmbeddings();
  } catch (e) {
    console.error('INDEX-NOTES: erro ao buscar embeddings:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log('INDEX-NOTES: embeddings existentes:', embeddingMap.size);

  // 3. Indexar notas sem embedding ou com embedding desatualizado
  let indexed = 0;
  const activeNoteIds = new Set();

  for (const note of notes) {
    activeNoteIds.add(note.id);

    const embUpdatedAt = embeddingMap.get(note.id);
    const needsIndex   = !embUpdatedAt || new Date(note.updated_at) > new Date(embUpdatedAt);

    if (!needsIndex) continue;

    try {
      await indexNote(note.id, note.user_id, note.title, note.content);
      indexed++;
      console.log('INDEX-NOTES: indexada nota', note.id);
    } catch (e) {
      console.error('INDEX-NOTES: erro ao indexar nota', note.id, ':', e.message);
      // Continua para a próxima nota — uma falha não derruba o cron
    }
  }

  // 4. Limpar órfãos — só executa se a busca de notas teve sucesso e retornou ≥1
  let removed = 0;

  if (notes.length > 0) {
    for (const [noteId] of embeddingMap) {
      if (!activeNoteIds.has(noteId)) {
        try {
          const ok = await deleteEmbedding(noteId);
          if (ok) {
            removed++;
            console.log('INDEX-NOTES: órfão removido', noteId);
          }
        } catch (e) {
          console.error('INDEX-NOTES: erro ao remover órfão', noteId, ':', e.message);
        }
      }
    }
  } else {
    console.warn('INDEX-NOTES: SALVAGUARDA — busca retornou 0 notas, limpeza de órfãos ignorada');
  }

  console.log(
    'INDEX-NOTES CRON: done. total:', notes.length,
    '| indexadas:', indexed,
    '| órfãos removidos:', removed
  );

  return res.json({
    ok:      true,
    total:   notes.length,
    indexed,
    removed,
  });
}
