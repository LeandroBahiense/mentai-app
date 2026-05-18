/**
 * Pallyum — RAG: geração e busca de embeddings
 * Modelo: text-embedding-3-small (OpenAI) — 1536 dims
 * Fonte da verdade: Pallyum-Planos-e-Precos.md seção 11
 */

const EMBEDDING_MODEL = 'text-embedding-3-small';
const SIMILARITY_THRESHOLD = 0.7;
const TOP_K_DEFAULT = 8;
const FALLBACK_RECENT = 5;

// ── Supabase factory (lazy) ───────────────────────────────────
function makeSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─────────────────────────────────────────────────────────────
// embedText(text) → number[]
//   Gera embedding via OpenAI text-embedding-3-small.
// ─────────────────────────────────────────────────────────────
export async function embedText(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8192), // limite de segurança
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

// ─────────────────────────────────────────────────────────────
// indexNote(noteId, userId, title, content)
//   Gera embedding e salva/atualiza em note_embeddings.
//   Chamado de forma síncrona ao criar/editar uma nota.
// ─────────────────────────────────────────────────────────────
export async function indexNote(noteId, userId, title, content) {
  try {
    const textToEmbed = [title, content].filter(Boolean).join('\n').slice(0, 8192);
    const embedding = await embedText(textToEmbed);
    const sb = makeSupabase();

    await sb.from('note_embeddings').upsert({
      note_id:    noteId,
      user_id:    userId,
      title:      title || '',
      embedding:  JSON.stringify(embedding),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'note_id' });

    console.log(`[embeddings] Indexed note ${noteId} for user ${userId}`);
  } catch (e) {
    // Indexação falha silenciosamente — não bloqueia o save da nota
    console.error('[embeddings] indexNote error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// searchRelevantNotes(userId, query, topK?) → Note[]
//   Busca semântica no vault do usuário.
//   Retorna array de { note_id, title, content, similarity }
//
//   Se nenhuma nota atingir threshold 0.7 → fallback nas 5
//   notas mais recentes (sem filtro semântico).
// ─────────────────────────────────────────────────────────────
export async function searchRelevantNotes(userId, query, topK = TOP_K_DEFAULT) {
  const sb = makeSupabase();

  try {
    // 1. Gerar embedding da query
    const queryEmbedding = await embedText(query);

    // 2. Busca semântica via função match_notes (pgvector)
    const { data: matches, error } = await sb.rpc('match_notes', {
      p_user_id:   userId,
      p_embedding: JSON.stringify(queryEmbedding),
      p_threshold: SIMILARITY_THRESHOLD,
      p_top_k:     topK,
    });

    if (error) throw new Error(error.message);

    if (matches && matches.length > 0) {
      // 3. Buscar conteúdo completo das notas encontradas
      const noteIds = matches.map(m => m.note_id);
      const { data: notes } = await sb
        .from('notes')
        .select('id, title, content, updated_at')
        .in('id', noteIds)
        .eq('user_id', userId);

      if (!notes) return [];

      // Ordenar pelo ranking semântico
      const noteMap = Object.fromEntries(notes.map(n => [n.id, n]));
      return matches
        .filter(m => noteMap[m.note_id])
        .map(m => ({
          ...noteMap[m.note_id],
          similarity: m.similarity,
        }));
    }

    // 4. Fallback: notas mais recentes
    console.log(`[embeddings] No semantic matches for user ${userId}, using fallback`);
    return await getRecentNotes(userId, FALLBACK_RECENT);

  } catch (e) {
    console.error('[embeddings] searchRelevantNotes error:', e.message);
    // Em caso de erro, tenta fallback
    try {
      return await getRecentNotes(userId, FALLBACK_RECENT);
    } catch (_) {
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────
// getRecentNotes(userId, limit) → Note[]
//   Busca as N notas mais recentes (fallback sem semântica).
// ─────────────────────────────────────────────────────────────
async function getRecentNotes(userId, limit = FALLBACK_RECENT) {
  const sb = makeSupabase();
  const { data } = await sb
    .from('notes')
    .select('id, title, content, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// buildRagContext(notes) → string
//   Formata notas para inserção no system prompt do Claude.
// ─────────────────────────────────────────────────────────────
export function buildRagContext(notes) {
  if (!notes || notes.length === 0) return '';

  const formatted = notes.map((n, i) => {
    const title = n.title ? `**${n.title}**` : `Nota ${i + 1}`;
    const content = (n.content || '').slice(0, 2000);
    const sim = n.similarity ? ` (relevância: ${(n.similarity * 100).toFixed(0)}%)` : '';
    return `${title}${sim}\n${content}`;
  }).join('\n\n---\n\n');

  return `\n\n## Notas relevantes do seu vault:\n\n${formatted}\n\n---\n`;
}
