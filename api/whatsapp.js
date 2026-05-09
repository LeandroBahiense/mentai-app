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

async function saveNoteToVault(note) {
  const id = 'wa-' + Date.now();
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes', {
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
  console.log('NOTA SUPABASE STATUS:', res.status);
  const result = await res.json();
  console.log('NOTA SUPABASE RESULT:', JSON.stringify(result));
  console.log('NOTA SALVA NO VAULT:', id, note.title);
  return id;
}

async function getHistory(phone) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/whatsapp_messages?phone=eq.' + encodeURIComponent(phone) + '&order=created_at.desc&limit=10&select=role,content', {
    headers: sbHeaders()
  });
  const data = await res.json();
  return Array.isArray(data) ? data.reverse() : [];
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
      max_tokens: 800,
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

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  if (req.method !== 'POST') return res.status(405).send(twiml('Método não permitido.'));

  const body = req.body || {};
  const phone = (body.From || '').replace('whatsapp:', '');
  const googlePhone = phone.replace(/^\+/, '');
  const mediaUrl = body.MediaUrl0 || '';
  const mediaType = (body.MediaContentType0 || '').toLowerCase();
  const hasAudio = mediaType.startsWith('audio/') && mediaUrl;

  let userMessage = (body.Body || '').trim();

  console.log('FROM:', phone, 'GOOGLE_PHONE:', googlePhone, 'MSG:', userMessage, 'AUDIO:', hasAudio ? mediaType : 'none');

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

  const needsCalendar  = /agenda|calend|evento|reuni|hoje|amanh|semana|hor[áa]rio|compromisso/i.test(userMessage);
  const needsGmail     = /e-?mails?|gmail|caixa|inbox|correio|mensagens?\s*(de\s*e-?mail)?/i.test(userMessage);
  const needsGoogle    = needsCalendar || needsGmail;
  const needsNoteSave  = /^(anota|salva|lembra|registra)\b/i.test(userMessage);

  let accessToken    = null;
  let calendarEvents = [];
  let gmailMessages  = [];
  let googleConnected = false;

  try {
    const googleTokens = await getGoogleTokens(googlePhone);

    console.log('GOOGLE TOKENS FOUND:', !!googleTokens, '| NEEDS_GMAIL:', needsGmail, '| NEEDS_CALENDAR:', needsCalendar);

    if (googleTokens) {
      if (Date.now() >= googleTokens.expiry_date - 60000) {
        accessToken = await refreshGoogleToken(googlePhone, googleTokens.refresh_token);
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
      const authLink = 'https://mentai-app.vercel.app/api/auth/google?phone=' + encodeURIComponent(googlePhone);
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
      system += 'INSTRUÇÃO ESPECIAL DE NOTA:\n';
      system += '- O usuário quer salvar uma nota. Extraia título, conteúdo resumido, cluster (produto/estrategia/equipe/pessoal/inbox) e tags relevantes.\n';
      system += '- Inclua ao final da resposta, em linha separada: [SALVAR_NOTA:{"title":"...","content":"...","cluster":"...","tags":["..."]}]\n';
      system += '- Confirme ao usuário de forma curta que a nota foi salva.\n\n';
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

    let finalReply = reply;
    const actionMatch = reply.match(/\[CRIAR_EVENTO:([\s\S]*?)\]/);

    if (actionMatch && accessToken) {
      try {
        const action = JSON.parse(actionMatch[1]);
        await createCalendarEvent(accessToken, action.title, action.datetime, action.description || '');
        finalReply = reply.replace(/\n?\[CRIAR_EVENTO:[\s\S]*?\]/, '').trim();
        console.log('EVENTO CRIADO:', action.title, action.datetime);
      } catch (err) {
        console.error('CALENDAR CREATE ERR:', err.message);
        finalReply = reply.replace(/\n?\[CRIAR_EVENTO:[\s\S]*?\]/, '').trim();
      }
    }

    const noteMatch = finalReply.match(/\[SALVAR_NOTA:([\s\S]*?)\]/);
    if (noteMatch) {
      try {
        const noteData = JSON.parse(noteMatch[1]);
        console.log('SALVANDO NOTA:', JSON.stringify(noteData));
        await saveNoteToVault(noteData);
        finalReply = finalReply.replace(/\n?\[SALVAR_NOTA:[\s\S]*?\]/, '').trim();
      } catch (err) {
        console.error('SAVE NOTE ERR:', err.message);
        finalReply = finalReply.replace(/\n?\[SALVAR_NOTA:[\s\S]*?\]/, '').trim();
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
