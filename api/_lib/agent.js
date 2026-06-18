/**
 * Pallyum — camada de agente (tools + chamada ao modelo + CRUD de notas)
 * Compartilhada por whatsapp.js e chat.js. Lógica de serviço pura — sem
 * dependências de canal (WhatsApp/web).
 */

import { indexNote } from './embeddings.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function googleSbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  };
}

function dataHojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// ─── Chamada ao modelo (com tools) ────────────────────────────────────────────

export async function askClaudeTools(system, messages, model, tools, toolChoice) {
  const resolvedModel = model || 'claude-sonnet-4-6';
  const body = { model: resolvedModel, max_tokens: 1500, system: system, messages: messages };
  if (tools && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('CLAUDE STATUS:', res.status, '| MODEL:', resolvedModel, '| tools_sent:', (tools ? tools.length : 0), '| stop:', data && data.stop_reason, '| forced:', (toolChoice ? 'any' : 'auto'));
  if (data.error) { console.error('CLAUDE ERROR:', JSON.stringify(data.error)); return null; }
  return data.content || null;
}

// ─── Definições de tools ──────────────────────────────────────────────────────

export const EVENT_TOOLS = [
  {
    name: 'criar_evento',
    description: 'Cria um evento na agenda conectada do usuário. Use sempre que o usuário pedir para marcar, agendar ou criar um compromisso, reunião, consulta, call ou lembrete com data e/ou hora — mesmo que não diga a palavra "agenda".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título curto do evento, ex: "Reunião".' },
        datetime: { type: 'string', description: 'Início em ISO com fuso de Brasília, ex: "2026-05-26T18:00:00-03:00". Use a tabela de datas do sistema para acertar o dia.' },
        account: { type: 'string', description: 'Opcional. E-mail da conta de agenda conectada onde criar, se o usuário indicar. Omita para a conta principal.' },
        description: { type: 'string', description: 'Opcional. Detalhes adicionais.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Opcional. Lista de e-mails dos convidados. Inclua APENAS e-mails que o usuário informou; se o usuário der só um nome, pergunte o e-mail.' }
      },
      required: ['title', 'datetime']
    }
  },
  {
    name: 'atualizar_evento',
    description: 'Altera a data/hora de um evento existente. Use quando o usuário pedir para remarcar ou mudar o horário de um compromisso.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título do evento a alterar.' },
        new_datetime: { type: 'string', description: 'Novo início em ISO com fuso de Brasília, ex: "2026-05-26T19:00:00-03:00".' },
        account: { type: 'string', description: 'Opcional. E-mail da conta, se o usuário indicar.' },
        event_ref: { type: 'string', description: 'Etiqueta interna [evtN] do evento na agenda. PREFIRA isto a `title` para identificar o evento a remarcar.' }
      },
      required: ['title', 'new_datetime']
    }
  },
  {
    name: 'apagar_evento',
    description: 'Cancela/apaga um evento INTEIRO da agenda, para TODOS os convidados. Use quando o usuário pedir para cancelar ou desmarcar o compromisso em si. NUNCA use para apenas tirar/remover um convidado de um evento que continua existindo — para isso use editar_convidados.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título do evento a cancelar.' },
        datetime: { type: 'string', description: 'Importante quando há vários eventos com o mesmo nome: o início (ISO, fuso de Brasília) do evento a cancelar, copiado da AGENDA. Ex: "2026-05-26T19:00:00-03:00".' },
        account: { type: 'string', description: 'Opcional. E-mail da conta, se o usuário indicar.' },
        event_ref: { type: 'string', description: 'Etiqueta interna [evtN] do evento na agenda. PREFIRA isto a `title` para identificar o evento a apagar.' }
      },
      required: ['title']
    }
  },
  {
    name: 'editar_convidados',
    description: 'Remove OU adiciona convidados de um evento que JÁ EXISTE, mantendo o evento. Use SEMPRE que o usuário pedir para tirar/remover um convidado, cancelar o convite de alguém, ou convidar mais alguém para um evento existente. NUNCA use apagar_evento para tirar convidado (isso cancela o evento inteiro para todos) nem criar_evento (isso duplica o evento).',
    input_schema: {
      type: 'object',
      properties: {
        event_ref: { type: 'string', description: 'Etiqueta interna [evtN] do evento. PREFIRA isto para identificar o evento; se não tiver a etiqueta, use o title.' },
        add: { type: 'array', items: { type: 'string' }, description: 'E-mails a convidar. Apenas e-mails que o usuário informou; se vier só um nome, pergunte o e-mail.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'E-mails a remover do evento. Apenas e-mails; se vier só um nome, pergunte o e-mail.' },
        title: { type: 'string', description: 'Título do evento. Usado para identificar o evento quando não há etiqueta [evtN], e na mensagem de confirmação.' },
        account: { type: 'string', description: 'Opcional. E-mail da conta de agenda, se o usuário indicar.' }
      },
      required: []
    }
  }
];

// Índice de eventos p/ endereçamento por ID. Recebe eventos JÁ enriquecidos (a camada
// chamadora anexa _provider/_accountEmail/_calendar_id). Atribui refs estáveis 'evtN' e
// devolve { text, indexMap } — o text vai ao prompt, o indexMap fica server-side p/ resolver
// a ref na hora de executar. Helper PURO (sem fetch, agnóstico de provider).
export function buildEventIndex(events) {
  if (!events || events.length === 0) return { text: '', indexMap: {} };
  const TZ = 'America/Sao_Paulo';
  const hojeBR = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());

  // Mesma lógica de label do formatCalendarEvents (google.js), replicada inline.
  const labelOf = function (e) {
    if (e.start && e.start.dateTime) {
      const dt     = new Date(e.start.dateTime);
      const diaSem = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' }).format(dt).replace('.', '');
      const dataBR = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(dt);
      const horaBR = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(dt);
      const eventoDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
      return eventoDia === hojeBR ? (diaSem + ' ' + horaBR) : (diaSem + ' ' + dataBR + ' ' + horaBR);
    }
    const d = (e.start && e.start.date) ? new Date(e.start.date + 'T00:00:00-03:00') : new Date();
    const diaSem = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' }).format(d).replace('.', '');
    const dataBR = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(d);
    return diaSem + ' ' + dataBR + ' (dia todo)';
  };

  const startMs = function (e) {
    if (e.start && e.start.dateTime) return new Date(e.start.dateTime).getTime();
    if (e.start && e.start.date) return new Date(e.start.date + 'T00:00:00-03:00').getTime();
    return 0;
  };

  const ordered = events.slice().sort(function (a, b) { return startMs(a) - startMs(b); });
  const indexMap = {};
  const lines = ordered.map(function (e, i) {
    const ref = 'evt' + (i + 1);
    indexMap[ref] = {
      provider:     e._provider,
      accountEmail: e._accountEmail,
      eventId:      e.id,
      calendarId:   e._calendar_id,
      attendees:    e.attendees || e.participants || [],
    };
    return '[' + ref + '] ' + labelOf(e) + ' — ' + (e.summary || 'Sem título') + ' — conta: ' + (e._accountEmail || '?');
  });
  return { text: lines.join('\n'), indexMap: indexMap };
}

// Aplica add/remove sobre a lista atual de convidados (objetos {email,...}).
// Preserva os objetos de quem fica (mantém RSVP). add entram como { email }. remove ganha de add no mesmo e-mail.
// Retorna { list, added, removed } — added/removed são os e-mails efetivamente mexidos.
export function mergeAttendees(current, add, remove) {
  const cur = Array.isArray(current) ? current : [];
  const addList = Array.isArray(add) ? add.filter(Boolean) : [];
  const remList = Array.isArray(remove) ? remove.filter(Boolean) : [];
  const emailOf = function (a) { return String((a && a.email) || '').toLowerCase(); };
  const remSet = new Set(remList.map(function (e) { return String(e).toLowerCase(); }));
  const removed = cur.filter(function (a) { return remSet.has(emailOf(a)); }).map(function (a) { return a.email; });
  const kept = cur.filter(function (a) { return !remSet.has(emailOf(a)); });
  const keptSet = new Set(kept.map(emailOf));
  const added = addList.filter(function (e) { const le = String(e).toLowerCase(); return !keptSet.has(le) && !remSet.has(le); });
  const list = kept.concat(added.map(function (e) { return { email: e }; }));
  return { list: list, added: added, removed: removed };
}

export const NOTE_TOOLS = [
  {
    name: 'criar_nota',
    description: 'Cria uma nota nova no vault. Use quando o usuário pedir para anotar, registrar, salvar ou guardar uma informação, ideia ou lembrete sem data/hora de compromisso.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título curto da nota.' },
        content: { type: 'string', description: 'Conteúdo da nota — apenas a informação a guardar, NUNCA a frase de comando do usuário.' },
        cluster: { type: 'string', enum: ['produto', 'estrategia', 'equipe', 'pessoal', 'inbox'], description: 'Categoria da nota.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Opcional. Etiquetas curtas.' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'atualizar_nota',
    description: 'Acrescenta conteúdo a uma nota que JÁ existe. Use quando o usuário pedir para adicionar/acrescentar algo a uma nota específica.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título EXATO da nota existente.' },
        content: { type: 'string', description: 'Texto a acrescentar.' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'apagar_nota',
    description: 'Apaga uma nota do vault. Use quando o usuário pedir para apagar/excluir uma nota.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Título da nota a apagar.' } },
      required: ['title']
    }
  }
];

// ─── CRUD de notas ────────────────────────────────────────────────────────────

export async function createNote(note) {
  const id = 'wa-' + Date.now();
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes', {
    method: 'POST',
    headers: { ...googleSbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      id,
      title:      note.title      || 'Nota sem título',
      content:    note.content    || '',
      folder:     note.folder     || 'inbox',
      cluster:    note.cluster    || 'inbox',
      tags:       note.tags       || [],
      user_id:    note.user_id    || null,
      date:       dataHojeSP(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('NOTE CREATE FAILED:', res.status, '|', note.title, '|', errBody);
    return null;
  }
  console.log('NOTE CREATED:', res.status, '|', note.title);
  await indexNote(id, note.user_id, note.title || 'Nota sem título', note.content || '');
  return id;
}

export async function updateNote(title, newContent, userId) {
  // Busca a nota pelo título filtrando pelo usuário — usa service role para bypassar RLS
  const filter = userId
    ? 'title=ilike.' + encodeURIComponent(title) + '&user_id=eq.' + encodeURIComponent(userId)
    : 'title=ilike.' + encodeURIComponent(title);

  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?' + filter + '&limit=1&select=id,title,content',
    { headers: googleSbHeaders() }
  );
  const notes = await res.json();
  console.log('NOTE UPDATE SEARCH:', JSON.stringify(notes));
  if (!Array.isArray(notes) || notes.length === 0) return false;

  // Se newContent parece um lembrete/adição, ACRESCENTA ao conteúdo existente
  // Se parece uma reescrita completa, SUBSTITUI
  const existingContent = notes[0].content || '';
  const isAddition = newContent.length < 300;
  const finalContent = isAddition
    ? existingContent + '\n\n- ' + newContent.trim()
    : newContent;

  const patch = await fetch(
    SUPABASE_URL + '/rest/v1/notes?id=eq.' + encodeURIComponent(notes[0].id),
    {
      method: 'PATCH',
      headers: { ...googleSbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ content: finalContent, updated_at: new Date().toISOString() }),
    }
  );
  console.log('NOTE UPDATE STATUS:', patch.status, '|', title);
  const ok = patch.status >= 200 && patch.status < 300;
  if (ok) {
    await indexNote(notes[0].id, userId, title, finalContent);
  }
  return ok;
}

export async function deleteNote(title) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?title=ilike.' + encodeURIComponent(title) + '&limit=1&select=id,title',
    { headers: googleSbHeaders() }
  );
  const notes = await res.json();
  console.log('NOTE TRASH SEARCH:', JSON.stringify(notes));
  if (!Array.isArray(notes) || notes.length === 0) return false;

  // Soft-delete: move pra lixeira (in_trash + deleted_at), idêntico ao app web.
  // Hard DELETE é barrado no banco e a web ressuscitaria a nota via sync.
  const patch = await fetch(
    SUPABASE_URL + '/rest/v1/notes?id=eq.' + encodeURIComponent(notes[0].id),
    {
      method: 'PATCH',
      headers: { ...googleSbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ in_trash: true, deleted_at: new Date().toISOString() }),
    }
  );
  console.log('NOTE TRASH STATUS:', patch.status, '|', title);
  return patch.status >= 200 && patch.status < 300;
}
