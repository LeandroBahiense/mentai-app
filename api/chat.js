/**
 * Pallyum — Chat API (app web)
 * Proxy para Anthropic com:
 *  - Roteamento de modelo por plano
 *  - Cooldown fair-use (delay artificial antes da resposta)
 *  - RAG semântico (busca no vault do usuário)
 *  - Tracking de uso em usage_logs
 */

import { getModelForUser, calculateCooldown, trackUsage } from './_lib/plans.js';
import { searchRelevantNotes, buildRagContext } from './_lib/embeddings.js';
import { createHmac, timingSafeEqual } from 'crypto';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── Identidade pelo cookie de sessão assinado (mesmo padrão do notes.js) ──────
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

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extrai o texto da última mensagem do usuário para RAG
function getLastUserText(messages) {
  if (!messages || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const textPart = msg.content.find(c => c.type === 'text');
      if (textPart) return textPart.text || '';
    }
  }
  return '';
}

// Detecta se a mensagem é conversacional ou solicita consulta ao vault
function needsRag(userText) {
  if (!userText || userText.length < 8) return false;
  const lower = userText.toLowerCase();
  // Gatilhos de vault/memória
  const vaultKeywords = [
    'nota', 'notas', 'anotei', 'anotação', 'lembre', 'lembrar', 'memória',
    'arquivo', 'armazenei', 'escrevi', 'escreveu', 'vault', 'diário',
    'tarefa', 'tarefas', 'projeto', 'projetos', 'ideia', 'ideias',
    'pesquisa', 'pesquisei', 'sobre', 'encontre', 'busque', 'busca',
    'que eu', 'o que eu', 'quando eu', 'como eu', 'já falei', 'já disse',
    'revisar', 'resumir', 'resumo', 'análise', 'analise',
  ];
  return vaultKeywords.some(kw => lower.includes(kw)) || userText.length > 100;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });

  // Identidade vem do cookie de sessão assinado — NUNCA do corpo (não-forjável).
  // Sem sessão válida, recusa: fecha leitura de notas de terceiros e uso anônimo da API.
  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'sessão inválida' });

  try {
    const body   = req.body || {};
    const userId = uid;

    // ── 1. Cooldown fair-use ──────────────────────────────────────────────────
    let cooldownMs = 0;
    if (userId) {
      const cooldown = await calculateCooldown(userId);
      if (cooldown === 'BLOCKED') {
        return res.status(429).json({
          error: 'Limite de uso atingido. Entre em contato com o suporte.',
          code: 'SUSPENDED',
        });
      }
      cooldownMs = cooldown || 0;
      if (cooldownMs > 0) {
        await sleep(cooldownMs);
      }
    }

    // ── 2. Roteamento de modelo ───────────────────────────────────────────────
    let model = body.model || 'claude-haiku-4-5';
    if (userId) {
      model = await getModelForUser(userId);
    }

    // ── 3. RAG — busca semântica ──────────────────────────────────────────────
    const messages   = body.messages || [];
    const userText   = getLastUserText(messages);
    let   ragContext = '';

    if (userId && needsRag(userText)) {
      try {
        const notes = await searchRelevantNotes(userId, userText);
        ragContext = buildRagContext(notes);
      } catch (e) {
        console.warn('RAG search error (non-fatal):', e.message);
      }
    }

    // ── 4. Montar payload para Anthropic ──────────────────────────────────────
    // Remove userId (campo interno) e sobrescreve model
    const { userId: _uid, ...anthropicBody } = body;

    // Injeta contexto RAG no system prompt
    if (ragContext) {
      const existingSystem = anthropicBody.system || '';
      anthropicBody.system = existingSystem + ragContext;
    }

    anthropicBody.model = model;

    // ── 5. Chamar Anthropic ───────────────────────────────────────────────────
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // ── 6. Tracking de uso ────────────────────────────────────────────────────
    if (userId) {
      // Detectar se havia áudio ou imagem na mensagem
      const hasAudio = messages.some(m =>
        Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use' && c.name === 'audio')
      );
      const hasImage = Array.isArray(body.messages) && messages.some(m =>
        Array.isArray(m.content) && m.content.some(c => c.type === 'image')
      );
      trackUsage(userId, 'app', { audio: hasAudio, image: hasImage }).catch(console.error);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('chat.js error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
