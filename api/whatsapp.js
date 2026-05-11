const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };
}

function googleSbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  };
}

function twiml(msg) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + msg + '</Message></Response>';
}

// Extrai JSON de uma tag no reply do Claude
function parseTagJson(reply, tagName) {
  const regex = new RegExp('\\[' + tagName + ':([\\s\\S]*?)\\]');
  const match = reply.match(regex);
  if (!match) return null;
  try {
    const cleaned = match[1]
      .replace(/```json\n?|\n?```/g, '')
      .replace(/[\x00-\x1F\x7F]/g, ' ')
      .trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('PARSE TAG ERR (' + tagName + '):', e.message, 'RAW:', match[1] ? match[1].substring(0, 200) : 'null');
    return null;
  }
}

// Remove todas as tags de ação do reply antes de enviar ao usuário
function stripActionTags(text) {
  return text
    .replace(/\n?\[CRIAR_NOTA:[\s\S]*?\]/g, '')
    .replace(/\n?\[ATUALIZAR_NOTA:[\s\S]*?\]/g, '')
    .replace(/\n?\[APAGAR_NOTA:[\s\S]*?\]/g, '')
    .replace(/\n?\[CRIAR_EVENTO:[\s\S]*?\]/g, '')
    .replace(/\n?\[ATUALIZAR_EVENTO:[\s\S]*?\]/g, '')
    .replace(/\n?\[APAGAR_EVENTO:[\s\S]*?\]/g, '')
    .trim();
}

// ─── Supabase: Mensagens ──────────────────────────────────────────────────────

async function saveMessage(phone, role, content) {
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_messages', {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ phone, role, content }),
  });
}

async function getHistory(phone) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/whatsapp_messages?phone=eq.' + encodeURIComponent(phone) +
    '&order=created_at.desc&limit=10&select=role,content',
    { headers: sbHeaders() }
  );
  const data = await res.json();
  console.log('HISTORY STATUS:', res.status, '| COUNT:', Array.isArray(data) ? data.length : 0);
  return Array.isArray(data) ? data.reverse() : [];
}

// ─── Supabase: Notas (CRUD) ───────────────────────────────────────────────────

async function getNotes() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?select=title,content,cluster&order=updated_at.desc&limit=15',
    { headers: sbHeaders() }
  );
  return await res.json();
}

async function searchNotesByContent(userId, query) {
  const encoded = encodeURIComponent('%' + query + '%');
  const url = SUPABASE_URL + '/rest/v1/notes'
    + '?or=(title.ilike.' + encoded + ',content.ilike.' + encoded + ')'
    + (userId ? '&user_id=eq.' + encodeURIComponent(userId) : '')
    + '&select=title,content,cluster'
    + '&limit=5';
  const res = await fetch(url, { headers: googleSbHeaders() });
  const data = await res.json();
  console.log('SEARCH NOTES:', query, '| FOUND:', Array.isArray(data) ? data.length : 0);
  return Array.isArray(data) ? data : [];
}

function extractKeywords(text) {
  // Remove stopwords e retorna as palavras mais relevantes
  const stopwords = new Set([
    'o','a','os','as','um','uma','uns','umas','de','do','da','dos','das',
    'em','no','na','nos','nas','por','para','com','que','me','se','não',
    'é','foi','são','está','isso','isto','aqui','você','eu','ele','ela',
    'quando','onde','quem','como','qual','quais','sobre','mais','já','tem',
    'o que','anotei','decidi','falei','escrito','lembro','tinha','disse',
  ]);
  return text
    .toLowerCase()
    .replace(/[^\w\sáéíóúâêôãõüç]/g, '')
    .split(/\s+/)
    .filter(function(w) { return w.length > 3 && !stopwords.has(w); })
    .slice(0, 3)
    .join(' ');
}

async function createNote(note) {
  const id = 'wa-' + Date.now();
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes', {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      id,
      title:      note.title      || 'Nota sem título',
      content:    note.content    || '',
      folder:     note.folder     || 'inbox',
      cluster:    note.cluster    || 'inbox',
      tags:       note.tags       || [],
      user_id:    note.user_id    || null,
      date:       new Date().toISOString().split('T')[0],
      updated_at: new Date().toISOString(),
    }),
  });
  console.log('NOTE CREATE STATUS:', res.status, '|', note.title);
  return id;
}

async function updateNote(title, newContent) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?title=ilike.' + encodeURIComponent(title) + '&limit=1&select=id,title',
    { headers: sbHeaders() }
  );
  const notes = await res.json();
  console.log('NOTE UPDATE SEARCH:', JSON.stringify(notes));
  if (!Array.isArray(notes) || notes.length === 0) return false;

  const patch = await fetch(
    SUPABASE_URL + '/rest/v1/notes?id=eq.' + encodeURIComponent(notes[0].id),
    {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ content: newContent, updated_at: new Date().toISOString() }),
    }
  );
  console.log('NOTE UPDATE STATUS:', patch.status, '|', title);
  return patch.status >= 200 && patch.status < 300;
}

async function deleteNote(title) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?title=ilike.' + encodeURIComponent(title) + '&limit=1&select=id,title',
    { headers: sbHeaders() }
  );
  const notes = await res.json();
  console.log('NOTE DELETE SEARCH:', JSON.stringify(notes));
  if (!Array.isArray(notes) || notes.length === 0) return false;

  const del = await fetch(
    SUPABASE_URL + '/rest/v1/notes?id=eq.' + encodeURIComponent(notes[0].id),
    { method: 'DELETE', headers: sbHeaders() }
  );
  console.log('NOTE DELETE STATUS:', del.status, '|', title);
  return del.status >= 200 && del.status < 300;
}

// ─── Google Tokens ───────────────────────────────────────────────────────────

async function getUserIdByPhone(phone) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/phone_users?phone=eq.' + encodeURIComponent(phone) + '&limit=1&select=user_id',
    { headers: googleSbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0].user_id : null;
}

async function getGoogleTokens(phone) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?phone=eq.' + encodeURIComponent(phone) + '&limit=1',
    { headers: googleSbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function refreshGoogleToken(phone, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const tokens = await res.json();
  if (tokens.error) throw new Error('Refresh falhou: ' + tokens.error);

  await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?phone=eq.' + encodeURIComponent(phone),
    {
      method: 'PATCH',
      headers: googleSbHeaders(),
      body: JSON.stringify({
        access_token: tokens.access_token,
        expiry_date:  Date.now() + tokens.expires_in * 1000,
        updated_at:   new Date().toISOString(),
      }),
    }
  );
  console.log('GOOGLE TOKEN REFRESHED:', phone);
  return tokens.access_token;
}

// ─── Google Calendar (CRUD) ───────────────────────────────────────────────────

async function getCalendarEvents(accessToken, date) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end   = new Date(date); end.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
  });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) { console.error('CALENDAR READ ERR:', JSON.stringify(data.error)); return []; }
  return data.items || [];
}

async function createCalendarEvent(accessToken, title, datetime, description) {
  const start = new Date(datetime);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary:     title,
      description: description || '',
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: end.toISOString(),   timeZone: 'America/Sao_Paulo' },
    }),
  });
  const data = await res.json();
  console.log('CALENDAR CREATE:', res.status, '|', title);
  return data;
}

async function findCalendarEvent(accessToken, title) {
  const now    = new Date();
  const past   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    q: title, timeMin: past.toISOString(), timeMax: future.toISOString(),
    singleEvents: 'true', maxResults: '5',
  });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  console.log('CALENDAR FIND:', (data.items || []).map(function(e) { return e.summary; }));
  return data.items && data.items.length > 0 ? data.items[0] : null;
}

async function updateCalendarEvent(accessToken, title, newDatetime) {
  const event = await findCalendarEvent(accessToken, title);
  if (!event) { console.log('EVENT NOT FOUND FOR UPDATE:', title); return false; }
  const start = new Date(newDatetime);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + event.id,
    {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
        end:   { dateTime: end.toISOString(),   timeZone: 'America/Sao_Paulo' },
      }),
    }
  );
  console.log('CALENDAR UPDATE STATUS:', res.status, '|', event.summary);
  return res.status >= 200 && res.status < 300;
}

async function deleteCalendarEvent(accessToken, title) {
  const event = await findCalendarEvent(accessToken, title);
  if (!event) { console.log('EVENT NOT FOUND FOR DELETE:', title); return false; }
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + event.id,
    { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  console.log('CALENDAR DELETE STATUS:', res.status, '|', event.summary);
  return res.status === 204;
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

async function getGmailMessages(accessToken) {
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=is:unread',
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const listData = await listRes.json();
  if (listData.error || !listData.messages) return [];

  return await Promise.all(listData.messages.map(async function(m) {
    const msgRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id +
      '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date',
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    const msgData = await msgRes.json();
    const headers = (msgData.payload && msgData.payload.headers) || [];
    const get = function(name) {
      const h = headers.find(function(h) { return h.name === name; });
      return h ? h.value : '';
    };
    return { from: get('From'), subject: get('Subject'), snippet: (msgData.snippet || '').substring(0, 150) };
  }));
}

// ─── Formatadores ────────────────────────────────────────────────────────────

function formatCalendarEvents(events) {
  if (!events || events.length === 0) return 'Nenhum evento hoje.';
  return events.map(function(e) {
    const time = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      : 'dia todo';
    return '- ' + time + ': ' + (e.summary || 'Sem título');
  }).join('\n');
}

function formatGmailMessages(messages) {
  if (!messages || messages.length === 0) return 'Nenhum email não lido.';
  return messages.map(function(m, i) {
    return (i + 1) + '. De: ' + m.from + '\n   Assunto: ' + m.subject + '\n   ' + m.snippet;
  }).join('\n\n');
}

// ─── Whisper ─────────────────────────────────────────────────────────────────

async function transcribeAudio(mediaUrl, contentType) {
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const audioRes = await fetch(mediaUrl, { headers: { 'Authorization': 'Basic ' + auth } });
  if (!audioRes.ok) throw new Error('Erro ao baixar áudio: ' + audioRes.status);

  const audioBuffer = await audioRes.arrayBuffer();
  const ext = contentType.includes('ogg') ? 'ogg'
    : contentType.includes('mp4') ? 'mp4'
    : contentType.includes('mpeg') ? 'mp3' : 'ogg';

  console.log('WHISPER: enviando áudio', ext, audioBuffer.byteLength, 'bytes');

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: contentType }), 'audio.' + ext);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: form,
  });
  const whisperData = await whisperRes.json();
  console.log('WHISPER STATUS:', whisperRes.status, '| TEXT:', (whisperData.text || '').substring(0, 80));
  return whisperData.text || null;
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function askClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1500,
      system:     system,
      messages:   messages,
    }),
  });
  console.log('CLAUDE STATUS:', res.status);
  const data = await res.json();
  if (data.content && data.content[0] && data.content[0].text) return data.content[0].text;
  if (data.error) console.error('CLAUDE ERROR:', JSON.stringify(data.error));
  return null;
}

// ─── Handler Principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  if (req.method !== 'POST') return res.status(405).send(twiml('Método não permitido.'));

  const body      = req.body || {};
  const phone     = (body.From || '').replace('whatsapp:', '');
  const mediaUrl  = body.MediaUrl0 || '';
  const mediaType = (body.MediaContentType0 || '').toLowerCase();
  const hasAudio  = mediaType.startsWith('audio/') && mediaUrl;

  let userMessage = (body.Body || '').trim();
  console.log('FROM:', phone, '| MSG:', userMessage.substring(0, 80), '| AUDIO:', hasAudio ? mediaType : 'none');

  // ── Transcrição de áudio ──────────────────────────────────────────────────
  if (hasAudio) {
    try {
      const transcription = await transcribeAudio(mediaUrl, mediaType);
      if (transcription) {
        userMessage = transcription;
        console.log('TRANSCRIPTION:', userMessage);
      } else {
        return res.send(twiml('Não consegui transcrever o áudio. Tente enviar uma mensagem de texto.'));
      }
    } catch (err) {
      console.error('TRANSCRIBE ERR:', err.message);
      return res.send(twiml('Erro ao processar áudio: ' + err.message));
    }
  }

  if (!userMessage) return res.send(twiml('Envie uma mensagem de texto ou áudio.'));

  // ── Detecta intenções ─────────────────────────────────────────────────────
  const needsCalendar = /agenda|calend|evento|reuni|hoje|amanh|semana|hor[áa]rio|compromisso/i.test(userMessage);
  const needsGmail    = /e-?mails?|gmail|caixa|inbox|correio/i.test(userMessage);
  const needsGoogle   = needsCalendar || needsGmail;

  // ── Google: tokens + dados ────────────────────────────────────────────────
  let accessToken    = null;
  let calendarEvents = [];
  let gmailMessages  = [];
  let googleConnected = false;
  let userId         = null;

  try {
    const [googleTokens, resolvedUserId] = await Promise.all([
      getGoogleTokens(phone),
      getUserIdByPhone(phone),
    ]);
    userId = resolvedUserId;
    console.log('GOOGLE TOKENS FOUND:', !!googleTokens, '| PHONE:', phone);
    console.log('USER ID:', userId);

    if (googleTokens) {
      accessToken = Date.now() >= googleTokens.expiry_date - 60000
        ? await refreshGoogleToken(phone, googleTokens.refresh_token)
        : googleTokens.access_token;
      googleConnected = true;
      calendarEvents  = await getCalendarEvents(accessToken, new Date());
      if (needsGmail) {
        gmailMessages = await getGmailMessages(accessToken);
        console.log('GMAIL MESSAGES:', gmailMessages.length);
      }
    } else if (needsGoogle) {
      const authLink = 'https://mentai-app.vercel.app/api/auth/google?phone=' + encodeURIComponent(phone);
      return res.send(twiml('Para acessar sua agenda e emails, conecte o Google primeiro: ' + authLink));
    }
  } catch (err) {
    console.error('GOOGLE ERR:', err.message);
  }

  // ── Histórico + Notas ─────────────────────────────────────────────────────
  try {
    const [notes, history] = await Promise.all([getNotes(), getHistory(phone)]);
    console.log('NOTES:', Array.isArray(notes) ? notes.length : 0);

    // ── Detecta pergunta sobre o vault e busca por conteúdo ───────────────
    const isVaultQuestion = /o que|quando|quem|onde|anotei|decidi|falei|está escrito|lembro|o que eu|o que a/i.test(userMessage);
    let searchResults = [];
    if (isVaultQuestion && userId) {
      const keywords = extractKeywords(userMessage);
      if (keywords) {
        searchResults = await searchNotesByContent(userId, keywords);
        console.log('VAULT SEARCH:', keywords, '| RESULTS:', searchResults.length);
      }
    }

    const vault = Array.isArray(notes)
      ? notes.map(function(n) { return '### ' + n.title + '\n' + (n.content || '').substring(0, 300); }).join('\n---\n')
      : '';

    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // ── System Prompt ─────────────────────────────────────────────────────
    let system = 'Você é o Jarvis, assistente pessoal via WhatsApp. Responda em português, de forma curta e direta.\n\n';
    system += 'Data/hora atual: ' + now + '\n\n';

    if (searchResults.length > 0) {
      const relevantVault = searchResults
        .map(function(n) { return '### ' + n.title + '\n' + (n.content || '').substring(0, 500); })
        .join('\n---\n');
      system += 'NOTAS RELEVANTES (corresponderam à busca — priorize estas na resposta):\n' + relevantVault + '\n\n';
    }

    system += 'NOTAS DO VAULT:\n' + (vault || '(nenhuma nota ainda)') + '\n\n';

    if (googleConnected) {
      system += 'AGENDA DE HOJE:\n' + formatCalendarEvents(calendarEvents) + '\n\n';
      if (gmailMessages.length > 0) {
        system += 'EMAILS NÃO LIDOS:\n' + formatGmailMessages(gmailMessages) + '\n\n';
      }
    }

    system += 'SUAS CAPACIDADES — quando o usuário pedir, execute E inclua a tag em linha separada ao final:\n';
    system += '• Criar nota:       [CRIAR_NOTA:{"title":"...","content":"...","cluster":"produto|estrategia|equipe|pessoal|inbox","tags":["..."]}]\n';
    system += '• Atualizar nota:   [ATUALIZAR_NOTA:{"title":"...","content":"..."}]\n';
    system += '• Apagar nota:      [APAGAR_NOTA:{"title":"..."}]\n';
    if (googleConnected) {
      system += '• Criar evento:     [CRIAR_EVENTO:{"title":"...","datetime":"YYYY-MM-DDTHH:mm:ss-03:00"}]\n';
      system += '• Atualizar evento: [ATUALIZAR_EVENTO:{"title":"...","newDatetime":"YYYY-MM-DDTHH:mm:ss-03:00"}]\n';
      system += '• Apagar evento:    [APAGAR_EVENTO:{"title":"..."}]\n';
    }
    system += 'Confirme cada ação ao usuário de forma curta. NUNCA diga que não consegue fazer essas ações.\n';

    // ── Chamada ao Claude ─────────────────────────────────────────────────
    const msgs = history
      .map(function(m) { return { role: m.role, content: m.content }; })
      .concat([{ role: 'user', content: userMessage }]);

    const reply = await askClaude(system, msgs);
    console.log('REPLY:', (reply || '').substring(0, 200));

    if (!reply) return res.send(twiml('Não consegui processar. Tente novamente.'));

    // ── Executa ações a partir das tags ──────────────────────────────────

    // Notas
    const criarNotaTag = reply.includes('[CRIAR_NOTA:');
    if (criarNotaTag) {
      try {
        const noteJson = await askClaude(
          'Extraia informações estruturadas. Responda SOMENTE com JSON puro, sem markdown, sem explicações: {"title":"...","cluster":"produto|estrategia|equipe|pessoal|inbox","tags":["..."]}',
          [{ role: 'user', content: 'Mensagem: ' + userMessage }]
        );
        const cleaned = noteJson.replace(/```json\n?|\n?```/g, '').trim();
        const noteData = JSON.parse(cleaned);
        noteData.content = userMessage;
        noteData.user_id = userId;
        await createNote(noteData);
        console.log('NOTE CREATED:', noteData.title);
      } catch (e) {
        console.error('CREATE NOTE ERR:', e.message);
      }
    }

    const atualizarNota = parseTagJson(reply, 'ATUALIZAR_NOTA');
    if (atualizarNota) {
      try { await updateNote(atualizarNota.title, atualizarNota.content); }
      catch (e) { console.error('UPDATE NOTE ERR:', e.message); }
    }

    const apagarNota = parseTagJson(reply, 'APAGAR_NOTA');
    if (apagarNota) {
      try { await deleteNote(apagarNota.title); }
      catch (e) { console.error('DELETE NOTE ERR:', e.message); }
    }

    // Eventos
    const criarEvento = parseTagJson(reply, 'CRIAR_EVENTO');
    if (criarEvento && accessToken) {
      try { await createCalendarEvent(accessToken, criarEvento.title, criarEvento.datetime, criarEvento.description || ''); }
      catch (e) { console.error('CREATE EVENT ERR:', e.message); }
    }

    const atualizarEvento = parseTagJson(reply, 'ATUALIZAR_EVENTO');
    if (atualizarEvento && accessToken) {
      try { await updateCalendarEvent(accessToken, atualizarEvento.title, atualizarEvento.newDatetime); }
      catch (e) { console.error('UPDATE EVENT ERR:', e.message); }
    }

    const apagarEvento = parseTagJson(reply, 'APAGAR_EVENTO');
    if (apagarEvento && accessToken) {
      try { await deleteCalendarEvent(accessToken, apagarEvento.title); }
      catch (e) { console.error('DELETE EVENT ERR:', e.message); }
    }

    // ── Limpa tags do reply e salva histórico ─────────────────────────────
    const finalReply = stripActionTags(reply);

    await saveMessage(phone, 'user', userMessage);
    await saveMessage(phone, 'assistant', finalReply);

    return res.send(twiml(finalReply));

  } catch (err) {
    console.error('ERR:', err.message);
    return res.send(twiml('Erro: ' + err.message));
  }
}
