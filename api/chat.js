/**
 * Pallyum — Chat API (app web)
 * Proxy para Anthropic com:
 *  - Roteamento de modelo por plano
 *  - Cooldown fair-use (delay artificial antes da resposta)
 *  - RAG semântico (busca no vault do usuário)
 *  - Tracking de uso em usage_logs
 */

import { getModelForUser, calculateCooldown, trackUsage, isPlanActive } from './_lib/plans.js';
import { searchRelevantNotes, buildRagContext } from './_lib/embeddings.js';
import { askClaudeTools, EVENT_TOOLS, NOTE_TOOLS, createNote, updateNote, deleteNote, buildEventIndex, mergeAttendees } from './_lib/agent.js';
import { getAllGoogleAccounts, ensureAccountToken, getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, formatCalendarEvents, patchGoogleEventTime, patchGoogleEventAttendees, deleteGoogleEventById } from './_lib/google.js';
import { getAllNylasGrants, getCalendarEventsNylas, createCalendarEventNylas, updateCalendarEventNylas, deleteCalendarEventNylas, updateNylasEventTime, updateNylasEventParticipants, deleteNylasEventById } from './_lib/nylas.js';
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

  // Gate de plano ativo (Etapa 04): expirado → 402; o front mostra o modo leitura.
  if (!(await isPlanActive(uid))) {
    return res.status(402).json({ error: 'plano_inativo' });
  }

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
      let eventIndexMap = {};   // ref [evtN] → { provider, accountEmail, eventId, calendarId, attendees } (resolve no loop de tools)

      // Grants Nylas no escopo do HANDLER de tools (busca dedicada p/ ESCRITA de evento).
      // Separada do bloco de leitura (170–186) — não reusa a var interna nylasGrants de lá.
      let nylasWrite = [];
      try { nylasWrite = await getAllNylasGrants(userId); } catch (e) { nylasWrite = []; }
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
              evs.forEach(e => { e._accountEmail = acc.email; e._provider = 'google'; e._calendar_id = 'primary'; });
              calendarEvents = calendarEvents.concat(evs);
            } catch (e) { console.error('CHAT CAL ERR (' + acc.email + '):', e.message); }
          }
          // Une grants Nylas (Outlook/iCloud/IMAP…) — read-only, já vem no shape Google.
          // Chaveado por user_id; se userId for null, pula (sem fallback por phone).
          let nylasGrants = [];
          if (userId) {
            try {
              nylasGrants = await getAllNylasGrants(userId);
              for (const g of nylasGrants) {
                try {
                  const evs = await getCalendarEventsNylas(g);
                  evs.forEach(e => { e._accountEmail = g.email; e._provider = 'nylas'; e._calendar_id = e.calendar_id; });
                  calendarEvents = calendarEvents.concat(evs);
                } catch (e) { console.error('NYLAS CAL ACCOUNT ERR (' + g.email + '):', e.message); }
              }
            } catch (e) { console.error('NYLAS GRANTS ERR:', e.message); }
          }
          calendarEvents.sort((a, b) =>
            new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
          console.log('CALENDAR EVENTS (com Nylas):', calendarEvents.length, '| nylas grants:', nylasGrants?.length || 0);
        }
        else if (nylasWrite.length > 0) {
          // Só-Nylas (zero contas Google): lê a agenda direto dos grants Nylas já carregados.
          for (const g of nylasWrite) {
            try {
              const evs = await getCalendarEventsNylas(g);
              evs.forEach(e => { e._accountEmail = g.email; e._provider = 'nylas'; e._calendar_id = e.calendar_id; });
              calendarEvents = calendarEvents.concat(evs);
            }
            catch (e) { console.error('CHAT leitura Nylas (só-Nylas) FAIL:', e.message); }
          }
          calendarEvents.sort((a, b) =>
            new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
        }
      } catch (e) { console.error('CHAT GOOGLE ERR:', e.message); }
      const googleConnected = accounts.length > 0;

      // Índice de eventos: refs [evtN] p/ endereçamento por id. text → contexto; indexMap → loop de tools.
      const __idx = buildEventIndex(calendarEvents);
      eventIndexMap = __idx.indexMap;

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
      const temAgenda = (accounts.length > 0) || (nylasWrite.length > 0);
      if (temAgenda) {
        system += 'AGENDA (próximos dias, horário de Brasília):\n' + (__idx.text || 'Nenhum evento nos próximos dias.') + '\n\n';
      }

      system += 'AÇÕES — use as FERRAMENTAS para agir quando o usuário pedir uma ação (não descreva a ação só em texto). Notas: criar_nota (registrar informação ou ideia), atualizar_nota (acrescentar a uma nota existente, pelo título exato), apagar_nota.\n';
      if (temAgenda) {
        const listaGoogle = accounts.map(a => a.email + (a.is_primary ? ' (principal)' : ''));
        const listaNylas  = nylasWrite.map(g => g.email + (g.provider ? ' (' + g.provider + ')' : '') + (g.is_primary ? ' (principal)' : ''));
        const listaContas = listaGoogle.concat(listaNylas).join(', ');
        system += 'CONTAS DE AGENDA CONECTADAS (para eventos): ' + listaContas + '.\n';
        system += 'Agenda: use criar_evento, atualizar_evento, apagar_evento para marcar, remarcar ou cancelar compromissos com data ou hora.\n';
        system += 'Para criar, editar ou apagar um evento numa conta específica, passe o email dela no parâmetro `account` — vale para qualquer conta listada acima, Google ou não.\n';
        system += 'Cada evento na agenda começa com uma etiqueta interna [evtN].\n';
        system += 'Para remarcar (atualizar_evento) ou cancelar (apagar_evento) um evento já existente, passe essa etiqueta no parâmetro event_ref — é mais preciso que o título.\n';
        system += 'NUNCA mostre a etiqueta [evtN] ao usuário; é interna, só para referenciar nas ferramentas.\n';
      }
      system += 'Distinção: marcar/agendar algo com data ou hora é sempre AGENDA (criar_evento), nunca nota; registrar informação/ideia é NOTA (criar_nota); no conteúdo da nota coloque só a informação, nunca a frase de comando. Para perguntas e conversa, responda em texto sem acionar ferramenta. Para QUALQUER ação na agenda (criar, remarcar, cancelar) você DEVE usar a ferramenta correspondente — criar_evento, atualizar_evento ou apagar_evento. NUNCA diga que marcou, remarcou ou cancelou um evento sem ter chamado a ferramenta; isso engana o usuário. Se faltar informação para agir (qual evento, qual conta, qual horário), PERGUNTE em vez de inventar uma confirmação. Confirme apenas o que a ferramenta fez.\n';
      system += 'Convidados: o parâmetro attendees de criar_evento é uma lista opcional de e-mails. Use convidados apenas quando o usuário pedir e apenas por e-mail; se vier só o nome, PERGUNTE o e-mail em vez de inventar. Antes de criar um evento COM convidados, confirme na mesma frase de confirmação nomeando quem será convidado e avisando que um convite será enviado a esses e-mails; só chame criar_evento depois do ok do usuário. Sem convidados, o fluxo segue normal.\n';
      system += 'Editar convidados: para adicionar ou remover convidado de um evento que JÁ existe, use editar_convidados com a etiqueta [evtN] do evento e os e-mails em add/remove (só e-mails; se vier só o nome, pergunte o e-mail). Antes de chamar, confirme com o usuário nomeando quem entra ou sai e avisando que o adicionado recebe convite e o removido recebe aviso. Nunca use apagar_evento para tirar um convidado — isso cancela o evento inteiro.\n';

      const tools = temAgenda ? NOTE_TOOLS.concat(EVENT_TOOLS) : NOTE_TOOLS;

      // tool_choice auto: o modelo decide se chama ferramenta, guiado pela linha de Distinção
      // do prompt. Antes, um regex de "ação" forçava { type:'any' } e fazia perguntas
      // ("qual minha agenda?") virarem chamada de criar_evento.
      const content = await askClaudeTools(system, messages, model, tools, undefined);
      const replyText = (content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      const toolUses = (content || []).filter(b => b && b.type === 'tool_use');
      console.log('CHAT AGENT REPLY:', (replyText || '').substring(0, 120), '| TOOLS:', toolUses.map(t => t.name).join(','));

      // Token Google de uma conta + fallback sequencial principal-primeiro (como antes).
      const _tokenGoogleSequencial = async (contaAlvo) => {
        const ordenados = [contaAlvo, ...accounts.filter(a => a !== contaAlvo)];
        for (const acc of ordenados) {
          try { return await ensureAccountToken(acc); }
          catch (e) { console.error('CHAT resolverContaToken FAIL (' + acc.email + '):', e.message); }
        }
        return null;
      };
      // Resolução TYPE-AWARE da conta-alvo p/ ESCRITA de evento.
      // Retorna { tipo:'google', token } | { tipo:'nylas', grant } | null.
      const resolverContaAlvo = async (emailAlvo) => {
        if (emailAlvo) {
          const g = accounts.find(a => a.email === emailAlvo);
          if (g) { const token = await _tokenGoogleSequencial(g); return token ? { tipo: 'google', token } : null; }
          const n = nylasWrite.find(x => x.email === emailAlvo);
          if (n) return { tipo: 'nylas', grant: n };
          // alvo não casou: cai pra principal global abaixo.
        }
        // Sem conta-alvo (ou alvo não-casado): principal global — Google primeiro, senão Nylas.
        // 1) principal global explícita (só UMA conta tem is_primary — backend cross-table garante)
        const gPrim = accounts.find(a => a.is_primary);
        if (gPrim) { const token = await _tokenGoogleSequencial(gPrim); return token ? { tipo: 'google', token } : null; }
        const nPrim = nylasWrite.find(x => x.is_primary);
        if (nPrim) return { tipo: 'nylas', grant: nPrim };
        // 2) nenhuma marcada → default: primeira Google, senão primeira Nylas
        if (accounts.length > 0) { const token = await _tokenGoogleSequencial(accounts[0]); return token ? { tipo: 'google', token } : null; }
        if (nylasWrite.length > 0) return { tipo: 'nylas', grant: nylasWrite[0] };
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
            // Aborta SÓ se não houver conta alguma (Google nem Nylas).
            if (accounts.length === 0 && nylasWrite.length === 0) {
              actionConfirm += '⚠️ Conecte uma agenda em Configurações → Conexões externas.\n';
              continue;
            }
            const alvo = await resolverContaAlvo(inp.account);
            if (!alvo) {
              actionConfirm += '⚠️ Não consegui acessar sua agenda. Reconecte em Configurações → Conexões externas.\n';
              continue;
            }
            if (tu.name === 'criar_evento') {
              const _conv = Array.isArray(inp.attendees) ? inp.attendees.filter(Boolean) : [];
              const r = (alvo.tipo === 'nylas')
                ? await createCalendarEventNylas(alvo.grant, inp.title, inp.datetime, inp.description || '', _conv)
                : await createCalendarEvent(alvo.token, inp.title, inp.datetime, inp.description || '', _conv);
              const _okMsg = _conv.length ? ('✅ "' + inp.title + '" agendado com convite para ' + _conv.join(', ') + '.\n') : ('✅ "' + inp.title + '" agendado.\n');
              actionConfirm += (r && r.id) ? _okMsg : ('⚠️ Não consegui criar "' + inp.title + '".\n');
            } else if (tu.name === 'atualizar_evento') {
              if (inp.event_ref && eventIndexMap[inp.event_ref]) {
                const _e = eventIndexMap[inp.event_ref];
                let _ok;
                if (_e.provider === 'google') {
                  const _acc = accounts.find(a => a.email === _e.accountEmail);
                  const _tk  = _acc ? await _tokenGoogleSequencial(_acc) : null;
                  _ok = _tk ? await patchGoogleEventTime(_tk, _e.eventId, inp.new_datetime) : false;
                } else {
                  const _gr = nylasWrite.find(x => x.email === _e.accountEmail);
                  _ok = _gr ? !!(await updateNylasEventTime(_gr, _e.eventId, _e.calendarId, inp.new_datetime)) : false;
                }
                actionConfirm += _ok ? ('🔄 "' + (inp.title || 'evento') + '" remarcado.\n')
                                     : ('⚠️ Não consegui remarcar "' + (inp.title || 'evento') + '".\n');
              } else {
                // FALLBACK (sem event_ref): resolverContaAlvo + busca por título (comportamento atual).
                const ok = (alvo.tipo === 'nylas')
                  ? !!(await updateCalendarEventNylas(alvo.grant, inp.title, inp.new_datetime))
                  : await updateCalendarEvent(alvo.token, inp.title, inp.new_datetime);
                actionConfirm += ok ? ('✅ "' + inp.title + '" remarcado.\n') : ('⚠️ Não encontrei "' + inp.title + '" para remarcar.\n');
              }
            } else {
              if (inp.event_ref && eventIndexMap[inp.event_ref]) {
                const _e = eventIndexMap[inp.event_ref];
                let _ok;
                if (_e.provider === 'google') {
                  const _acc = accounts.find(a => a.email === _e.accountEmail);
                  const _tk  = _acc ? await _tokenGoogleSequencial(_acc) : null;
                  _ok = _tk ? await deleteGoogleEventById(_tk, _e.eventId, 'none') : false;
                } else {
                  const _gr = nylasWrite.find(x => x.email === _e.accountEmail);
                  _ok = _gr ? await deleteNylasEventById(_gr, _e.eventId, _e.calendarId, false) : false;
                }
                actionConfirm += _ok ? ('🗑️ "' + (inp.title || 'evento') + '" cancelado.\n')
                                     : ('⚠️ Não consegui cancelar "' + (inp.title || 'evento') + '".\n');
              } else {
                // FALLBACK (sem event_ref): resolverContaAlvo + busca por título (comportamento atual).
                const ok = (alvo.tipo === 'nylas')
                  ? await deleteCalendarEventNylas(alvo.grant, inp.title, inp.datetime)
                  : await deleteCalendarEvent(alvo.token, inp.title, inp.datetime);
                actionConfirm += ok ? ('✅ "' + inp.title + '" cancelado.\n') : ('⚠️ Não encontrei "' + inp.title + '" para cancelar.\n');
              }
            }
          } else if (tu.name === 'editar_convidados') {
            if (accounts.length === 0 && nylasWrite.length === 0) {
              actionConfirm += '⚠️ Conecte uma agenda em Configurações → Conexões externas.\n';
              continue;
            }
            const _e = inp.event_ref ? eventIndexMap[inp.event_ref] : null;
            if (!_e) {
              actionConfirm += '⚠️ Não identifiquei qual evento alterar. Me diga qual é.\n';
              continue;
            }
            const _mrg = mergeAttendees(_e.attendees, inp.add, inp.remove);
            if (!_mrg.added.length && !_mrg.removed.length) {
              actionConfirm += 'ℹ️ Nada a alterar nos convidados de "' + (inp.title || 'evento') + '".\n';
              continue;
            }
            let _okE;
            if (_e.provider === 'google') {
              const _accE = accounts.find(a => a.email === _e.accountEmail);
              const _tkE  = _accE ? await _tokenGoogleSequencial(_accE) : null;
              _okE = _tkE ? await patchGoogleEventAttendees(_tkE, _e.eventId, _mrg.list) : false;
            } else {
              const _grE = nylasWrite.find(x => x.email === _e.accountEmail);
              _okE = _grE ? !!(await updateNylasEventParticipants(_grE, _e.eventId, _e.calendarId, _mrg.list)) : false;
            }
            if (_okE) {
              let _msgE = '✅ Convidados de "' + (inp.title || 'evento') + '" atualizados.';
              if (_mrg.added.length)   _msgE += ' Convite enviado para ' + _mrg.added.join(', ') + '.';
              if (_mrg.removed.length) _msgE += ' Removido(s): ' + _mrg.removed.join(', ') + '.';
              actionConfirm += _msgE + '\n';
            } else {
              actionConfirm += '⚠️ Não consegui alterar os convidados de "' + (inp.title || 'evento') + '".\n';
            }
          }
        } catch (e) { console.error('CHAT TOOL ERR:', tu.name, e.message); actionConfirm += '⚠️ Erro ao processar a ação.\n'; }
      }

      const finalReply = (actionConfirm ? actionConfirm.trim() : replyText) || 'Não consegui processar isso agora. Pode repetir?';
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
