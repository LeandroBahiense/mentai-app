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
import { askClaudeTools, EVENT_TOOLS, NOTE_TOOLS, createNote, updateNote, deleteNote } from './_lib/agent.js';
import { getAllGoogleAccounts, ensureAccountToken, getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, formatCalendarEvents } from './_lib/google.js';
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

    // ── 3b. Ramo AGÊNTICO (Chat IA web com tool use) ──────────────────────────
    // Só dispara com body.agent === true. O proxy abaixo (usado pela Voz) fica intacto.
    if (body.agent === true) {
      const TZ = 'America/Sao_Paulo';

      // Resolve contas Google + agenda agregada (multi-conta), igual ao WhatsApp.
      let accounts = [];
      let accessToken = null;
      let calendarEvents = [];
      try {
        accounts = await getAllGoogleAccounts(userId);
        if (accounts.length > 0) {
          const ordered = accounts.slice().sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
          for (const acc of ordered) {
            try { accessToken = await ensureAccountToken(acc); break; }
            catch (e) { console.error('CHAT TOKEN FAIL (' + acc.email + '):', e.message); }
          }
          for (const acc of accounts) {
            try {
              const tk = await ensureAccountToken(acc);
              const evs = await getCalendarEvents(tk);
              evs.forEach(e => { e._accountEmail = acc.email; });
              calendarEvents = calendarEvents.concat(evs);
            } catch (e) { console.error('CHAT CAL ERR (' + acc.email + '):', e.message); }
          }
          calendarEvents.sort((a, b) =>
            new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
        }
      } catch (e) { console.error('CHAT GOOGLE ERR:', e.message); }
      const googleConnected = accounts.length > 0;

      // System prompt agêntico (web): persona do frontend + grounding do servidor.
      const agoraTZ = new Intl.DateTimeFormat('pt-BR', {
        timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());

      let system = body.system
        ? (body.system + '\n\n')
        : 'Você é o assistente pessoal do Pallyum no app web. Responda em português.\n\n';
      system += 'Data e hora atuais: ' + agoraTZ + '. Use isto para resolver "hoje", "amanhã", dias da semana e datas relativas.\n\n';

      let refDatas = 'Tabela de datas (use SEMPRE para converter dias da semana; NUNCA calcule de cabeça):\n';
      const baseMs = Date.now();
      for (let i = 0; i <= 7; i++) {
        const d = new Date(baseMs + i * 86400000);
        const ds = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long' }).format(d);
        const df = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
        refDatas += '- ' + (i === 0 ? ds + ' (hoje)' : ds) + ': ' + df + '\n';
      }
      system += refDatas + '\n';

      if (ragContext) system += ragContext + '\n\n';
      if (googleConnected) {
        system += 'AGENDA (próximos dias, horário de Brasília):\n' + formatCalendarEvents(calendarEvents) + '\n\n';
      }

      system += 'AÇÕES — use as FERRAMENTAS para agir quando o usuário pedir uma ação (não descreva a ação só em texto). Notas: criar_nota (registrar informação ou ideia), atualizar_nota (acrescentar a uma nota existente, pelo título exato), apagar_nota.\n';
      if (googleConnected) {
        const listaContas = accounts.map(a => a.email + (a.is_primary ? ' (principal)' : '')).join(', ');
        system += 'CONTAS GOOGLE CONECTADAS (para eventos): ' + listaContas + '.\n';
        system += 'Agenda: use criar_evento, atualizar_evento, apagar_evento para marcar, remarcar ou cancelar compromissos com data ou hora.\n';
      }
      system += 'Distinção: marcar/agendar algo com data ou hora é sempre AGENDA (criar_evento), nunca nota; registrar informação/ideia é NOTA (criar_nota); no conteúdo da nota coloque só a informação, nunca a frase de comando. Para perguntas e conversa, responda em texto sem acionar ferramenta. Confirme cada ação de forma curta e nunca diga que não consegue fazê-las.\n';

      const tools = googleConnected ? NOTE_TOOLS.concat(EVENT_TOOLS) : NOTE_TOOLS;
      const ehAcao = /\b(marc|agend|cri[ae]|cancel|remarc|desmarc|reagend|adia|anot|registr|salv|apag|delet|adicion|exclu|altera|edita|mud[ae])/i.test(userText || '');
      const toolChoice = (ehAcao && tools.length) ? { type: 'any' } : undefined;

      const content = await askClaudeTools(system, messages, model, tools, toolChoice);
      const replyText = (content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      const toolUses = (content || []).filter(b => b && b.type === 'tool_use');
      console.log('CHAT AGENT REPLY:', (replyText || '').substring(0, 120), '| TOOLS:', toolUses.map(t => t.name).join(','));

      // Resolve token da conta-alvo (fallback principal-primeiro).
      const resolverContaToken = async (emailAlvo) => {
        if (accounts.length === 0) return null;
        const principal = accounts.find(a => a.is_primary) || accounts[0];
        const contaAlvo = (emailAlvo && accounts.find(a => a.email === emailAlvo)) || principal;
        const ordenados = [contaAlvo, ...accounts.filter(a => a !== contaAlvo)];
        for (const acc of ordenados) {
          try { return await ensureAccountToken(acc); }
          catch (e) { console.error('CHAT resolverContaToken FAIL (' + acc.email + '):', e.message); }
        }
        return null;
      };

      let actionConfirm = '';
      for (const tu of toolUses) {
        const inp = tu.input || {};
        try {
          if (tu.name === 'criar_nota') {
            inp.user_id = userId;
            const id = await createNote(inp);
            actionConfirm += id ? ('📝 Nota "' + (inp.title || '') + '" criada.\n') : ('⚠️ Não consegui criar a nota.\n');
          } else if (tu.name === 'atualizar_nota') {
            const ok = await updateNote(inp.title, inp.content || userText, userId);
            actionConfirm += ok ? ('📝 Nota "' + inp.title + '" atualizada.\n') : ('⚠️ Não encontrei a nota "' + inp.title + '".\n');
          } else if (tu.name === 'apagar_nota') {
            const okDel = await deleteNote(inp.title);
            actionConfirm += okDel ? ('🗑️ Nota "' + inp.title + '" movida para a lixeira.\n') : ('⚠️ Não encontrei a nota "' + inp.title + '".\n');
          } else if (tu.name === 'criar_evento' || tu.name === 'atualizar_evento' || tu.name === 'apagar_evento') {
            if (!accessToken) {
              actionConfirm += accounts.length === 0
                ? '⚠️ Conecte sua agenda Google primeiro (Configurações).\n'
                : '⚠️ Sua conexão com o Google expirou. Reconecte em Configurações → Conexões externas.\n';
              continue;
            }
            const tk = await resolverContaToken(inp.account);
            if (tu.name === 'criar_evento') {
              const r = await createCalendarEvent(tk, inp.title, inp.datetime, inp.description || '');
              actionConfirm += (r && r.id) ? ('✅ "' + inp.title + '" agendado.\n') : ('⚠️ Não consegui criar "' + inp.title + '".\n');
            } else if (tu.name === 'atualizar_evento') {
              const ok = await updateCalendarEvent(tk, inp.title, inp.new_datetime);
              actionConfirm += ok ? ('✅ "' + inp.title + '" remarcado.\n') : ('⚠️ Não encontrei "' + inp.title + '" para remarcar.\n');
            } else {
              const ok = await deleteCalendarEvent(tk, inp.title, inp.datetime);
              actionConfirm += ok ? ('✅ "' + inp.title + '" cancelado.\n') : ('⚠️ Não encontrei "' + inp.title + '" para cancelar.\n');
            }
          }
        } catch (e) { console.error('CHAT TOOL ERR:', tu.name, e.message); actionConfirm += '⚠️ Erro ao processar a ação.\n'; }
      }

      const finalReply = (actionConfirm ? actionConfirm.trim() : replyText) || '✅ Feito!';
      trackUsage(userId, 'app', {}).catch(console.error);
      return res.status(200).json({ content: [{ type: 'text', text: finalReply }] });
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
