const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// Headers para tabelas normais (anon key)
function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };
}

// Headers para google_tokens (service role — RLS ativo)
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

// ─── Supabase ────────────────────────────────────────────────────────────────

async function getNotes() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes?select=title,content,cluster&order=updated_at.desc&limit=15', {
    headers: sbHeaders()
  });
  return await res.json();
}

async function saveMessage(phone, role, content) {
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_messages', {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ phone, role, content })
  });
}

async function updateNoteInVault(title, newContent) {
  // Busca nota pelo título
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes?title=eq.' + encodeURIComponent(title) + '&limit=1&select=id,title', {
    headers: sbHeaders()
  });
  const notes = await res.json();
  console.log('UPDATE NOTE SEARCH:', JSON.stringify(notes));
  if (!Array.isArray(notes) || notes.length === 0) {
    console.log('NOTA NAO ENCONTRADA PARA UPDATE:', title);
    return false;
  }
  const patchRes = await fetch(SUPABASE_URL + '/rest/v1/notes?id=eq.' + encodeURIComponent(notes[0].id), {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      content:    newContent,
      updated_at: new Date().toISOString(),
    }),
  });
  console.log('NOTA ATUALIZADA STATUS:', patchRes.status, '| TITLE:', title);
  return patchRes.status >= 200 && patchRes.status < 300;
}

async function saveNoteToVault(note) {
  const id = 'wa-' + Date.now();
  const sbRes = await fetch(SUPABASE_URL + '/rest/v1/notes', {
    method: 'POST',
    headers: {
      ...sbHeaders(),
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      id,
      title:      note.title || 'Nota sem título',
      content:    note.content || '',
      folder:     note.folder || 'inbox',
      cluster:    note.cluster || 'inbox',
      tags:       note.tags || [],
      date:       new Date().toISOString().split('T')[0],
      updated_at: new Date().toISOString(),
    }),
  });
  console.log('NOTA SUPABASE STATUS:', sbRes.status);
  const result = await sbRes.json();
  console.log('NOTA SUPABASE RESULT:', JSON.stringify(result));
  console.log('NOTA SALVA NO VAULT:', id, note.title);
  return id;
}

async function getHistory(phone) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/whatsapp_messages?phone=eq.' + encodeURIComponent(phone) + '&order=created_at.desc&limit=10&select=role,content', {
    headers: sbHeaders()
  });
  const data = await res.json();
  console.log('HISTORY STATUS:', res.status, '| COUNT:', Array.isArray(data) ? data.length : 0, '| DATA:', JSON.stringify(data).substring(0, 200));
  return Array.isArray(data) ? data.reverse() : [];
}

// ─── Google Tokens ───────────────────────────────────────────────────────────

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

  await fetch(SUPABASE_URL + '/rest/v1/google_tokens?phone=eq.' + encodeURIComponent(phone), {
    method: 'PATCH',
    headers: googleSbHeaders(),
    body: JSON.stringify({
      access_token: tokens.access_token,
      expiry_date:  Date.now() + tokens.expires_in * 1000,
      updated_at:   new Date().toISOString(),
    }),
  });

  console.log('GOOGLE TOKEN REFRESHED:', phone);
  return tokens.access_token;
}

// ─── Google Calendar ─────────────────────────────────────────────────────────

async function getCalendarEvents(accessToken, date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin:      start.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '10',
  });

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );

  const data = await res.json();
  if (data.error) {
    console.error('CALENDAR READ ERR:', JSON.stringify(data.error));
    return [];
  }
  return data.items || [];
}

async function createCalendarEvent(accessToken, title, datetime, description) {
  const start = new Date(datetime);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary:     title,
      description: description || '',
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: end.toISOString(),   timeZone: 'America/Sao_Paulo' },
    }),
  });

  const data = await res.json();
  console.log('CALENDAR CREATE:', JSON.stringify(data));
  return data;
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

async function getGmailMessages(accessToken) {
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=is:unread',
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const listData = await listRes.json();

  if (listData.error || !listData.messages) return [];

  const messages = await Promise.all(
    listData.messages.map(async function(m) {
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
      return {
        from:    get('From'),
        subject: get('Subject'),
        snippet: (msgData.snippet || '').substring(0, 150),
      };
    })
  );

  return messages;
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
  const audioRes = await fetch(mediaUrl, {
    headers: { 'Authorization': 'Basic ' + auth }
  });

  if (!audioRes.ok) throw new Error('Erro ao baixar áudio: ' + audioRes.status);

  const audioBuffer = await audioRes.arrayBuffer();
  const ext = contentType.includes('ogg') ? 'ogg'
    : contentType.includes('mp4') ? 'mp4'
    : contentType.includes('mpeg') ? 'mp3'
    : 'ogg';

  console.log('WHISPER: enviando áudio', ext, audioBuffer.byteLength, 'bytes');

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: contentType }), 'audio.' + ext);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: form
  });

  console.log('WHISPER STATUS:', whisperRes.status);
  const whisperData = await whisperRes.json();
  console.log('WHISPER RESPONSE:', JSON.stringify(whisperData));

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
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: system,
      messages: messages,
    })
  });
  console.log('CLAUDE STATUS:', res.status);
  const data = await res.json();
  console.log('CLAUDE RESPONSE:', JSON.stringify(data));
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text;
  }
  if (data.error) console.error('CLAUDE ERROR:', data.error);
  return null;
}

// ─── Handler Principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  if (req.method !== 'POST') return res.status(405).send(twiml('Método não permitido.'));

  const body = req.body || {};
  const phone = (body.From || '').replace('whatsapp:', '');
  const mediaUrl = body.MediaUrl0 || '';
  const mediaType = (body.MediaContentType0 || '').toLowerCase();
  const hasAudio = mediaType.startsWith('audio/') && mediaUrl;

  let userMessage = (body.Body || '').trim();

  console.log('FROM:', phone, 'MSG:', userMessage, 'AUDIO:', hasAudio ? mediaType : 'none');

  // Transcrição de áudio
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

  // Detecta intenções
  const needsCalendar   = /agenda|calend|evento|reuni|hoje|amanh|semana|hor[áa]rio|compromisso/i.test(userMessage);
  const needsGmail      = /e-?mails?|gmail|caixa|inbox|correio|mensagens?\s*(de\s*e-?mail)?/i.test(userMessage);
  const needsGoogle     = needsCalendar || needsGmail;
  const needsNoteSave   = /\b(anota|salva|lembra|registra|cri[ae]?|adiciona|guarda|armazena)\b.*\b(nota|anotação|lembrete|decisão|ideia|roadmap|reunião)\b|\b(anota|salva|lembra|registra)\b/i.test(userMessage);
  const needsNoteUpdate = /\b(inclua|adicione|atualize|acrescente|coloque|insira|edite|modifique|atualiza|muda|mude|complemente|complementa)\b/i.test(userMessage) && /\b(nota|roadmap|anotação|lembrete)\b/i.test(userMessage);
  console.log('NEEDS_NOTE_SAVE:', needsNoteSave, '| NEEDS_NOTE_UPDATE:', needsNoteUpdate, '| MSG:', userMessage.substring(0, 50));

  let accessToken    = null;
  let calendarEvents = [];
  let gmailMessages  = [];
  let googleConnected = false;

  try {
    const googleTokens = await getGoogleTokens(phone);

    console.log('GOOGLE TOKENS FOUND:', !!googleTokens, '| NEEDS_GMAIL:', needsGmail, '| NEEDS_CALENDAR:', needsCalendar, '| PHONE:', phone);

    if (googleTokens) {
      if (Date.now() >= googleTokens.expiry_date - 60000) {
        accessToken = await refreshGoogleToken(phone, googleTokens.refresh_token);
      } else {
        accessToken = googleTokens.access_token;
      }
      googleConnected = true;

      calendarEvents = await getCalendarEvents(accessToken, new Date());

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

  try {
    const [notes, history] = await Promise.all([getNotes(), getHistory(phone)]);

    const vault = Array.isArray(notes) ? notes.map(function(n) {
      return '### ' + n.title + '\n' + (n.content || '').substring(0, 250);
    }).join('\n---\n') : '';

    console.log('NOTES:', Array.isArray(notes) ? notes.length : 0);

    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    let system = 'Você é o Jarvis, assistente pessoal via WhatsApp. Responda em português, de forma curta (máximo 2 parágrafos).\n\n';
    system += 'Data/hora atual: ' + now + '\n\n';
    system += 'NOTAS:\n' + vault + '\n\n';

    if (needsNoteSave) {
      system += 'O usuário quer criar uma nota. Você TEM essa capacidade — confirme de forma curta que a nota foi criada.\n\n';
    }
    if (needsNoteUpdate) {
      system += 'O usuário quer atualizar uma nota existente. Você TEM essa capacidade — confirme de forma curta que a nota foi atualizada com os novos itens.\n\n';
    }

    if (googleConnected) {
      system += 'AGENDA DE HOJE:\n' + formatCalendarEvents(calendarEvents) + '\n\n';
      if (gmailMessages.length > 0) {
        system += 'EMAILS NÃO LIDOS:\n' + formatGmailMessages(gmailMessages) + '\n\n';
      }
      system += 'INSTRUÇÕES ESPECIAIS:\n';
      system += '- Se o usuário pedir para criar um evento no calendário, confirme na resposta E inclua ao final, em linha separada: [CRIAR_EVENTO:{"title":"...","datetime":"YYYY-MM-DDTHH:mm:ss-03:00"}]\n';
      system += '- Se o usuário pedir para rascunhar um email, escreva o rascunho completo na resposta.\n';
    }

    const msgs = history.map(function(m) {
      return { role: m.role, content: m.content };
    }).concat([{ role: 'user', content: userMessage }]);

    const reply = await askClaude(system, msgs);
    console.log('REPLY:', reply);

    if (!reply) return res.send(twiml('Não consegui processar. Tente novamente.'));

    // Remove tags de nota do reply antes de enviar ao usuário e salvar no histórico
    let finalReply = reply.replace(/\n?\[(?:CRIAR_NOTA|SALVAR_NOTA|ATUALIZAR_NOTA):[\s\S]*?\]/, '').trim();
    const actionMatch = reply.match(/\[CRIAR_EVENTO:([\s\S]*?)\]/);

    if (actionMatch && accessToken) {
      try {
        const action = JSON.parse(actionMatch[1]);
        await createCalendarEvent(accessToken, action.title, action.datetime, action.description || '');
        finalReply = finalReply.replace(/\n?\[CRIAR_EVENTO:[\s\S]*?\]/, '').trim();
        console.log('EVENTO CRIADO:', action.title, action.datetime);
      } catch (err) {
        console.error('CALENDAR CREATE ERR:', err.message);
        finalReply = finalReply.replace(/\n?\[CRIAR_EVENTO:[\s\S]*?\]/, '').trim();
      }
    }

    if (needsNoteUpdate) {
      try {
        const updateJson = await askClaude(
          'Você extrai informações de pedidos de atualização de notas. Responda APENAS com JSON puro, sem explicações, sem markdown, sem código.',
          [{
            role: 'user',
            content: 'Extraia o título exato da nota a ser atualizada e o novo conteúdo completo a ser inserido. Responda SOMENTE o JSON, nada mais:\n{"title":"...","content":"..."}\n\nMensagem: ' + userMessage
          }]
        );
        if (updateJson) {
          let jsonStr = updateJson.trim();
          jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          const tagMatch = jsonStr.match(/\[(?:ATUALIZAR_NOTA|CRIAR_NOTA|SALVAR_NOTA):([\s\S]*?)\]\s*$/);
          if (tagMatch) jsonStr = tagMatch[1].trim();
          console.log('UPDATE JSON PARSED:', jsonStr.substring(0, 100));
          const updateData = JSON.parse(jsonStr);
          const ok = await updateNoteInVault(updateData.title, updateData.content);
          console.log('NOTE UPDATE RESULT:', ok, updateData.title);
        }
      } catch (err) {
        console.error('UPDATE NOTE ERR:', err.message);
      }
    }

    if (needsNoteSave) {
      try {
        const noteJson = await askClaude(
          'Você extrai informações estruturadas de mensagens. Responda APENAS com JSON puro, sem explicações, sem markdown, sem código.',
          [{
            role: 'user',
            content: 'Extraia desta mensagem uma nota estruturada. Responda SOMENTE o JSON, nada mais:\n{"title":"...","content":"...","cluster":"produto|estrategia|equipe|pessoal|inbox","tags":["..."]}\n\nMensagem: ' + userMessage
          }]
        );
        if (noteJson) {
          let jsonStr = noteJson.trim();
          // Remove markdown code fences (```json ... ```)
          jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          // Remove tag wrapper se Claude retornou [CRIAR_NOTA:{...}] ou [SALVAR_NOTA:{...}]
          const tagMatch = jsonStr.match(/\[(?:CRIAR_NOTA|SALVAR_NOTA):([\s\S]*?)\]\s*$/);
          if (tagMatch) jsonStr = tagMatch[1].trim();
          console.log('NOTE JSON PARSED:', jsonStr.substring(0, 100));
          const noteData = JSON.parse(jsonStr);
          console.log('NOTA EXTRAIDA (2a chamada):', JSON.stringify(noteData));
          await saveNoteToVault(noteData);
        }
      } catch (err) {
        console.error('SAVE NOTE ERR:', err.message);
      }
    }

    await saveMessage(phone, 'user', userMessage);
    await saveMessage(phone, 'assistant', finalReply);

    return res.send(twiml(finalReply));
  } catch (err) {
    console.error('ERR:', err.message);
    return res.send(twiml('Erro: ' + err.message));
  }
}
