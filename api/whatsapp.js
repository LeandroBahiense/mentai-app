const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;
const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN      = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM       = process.env.TWILIO_WHATSAPP_FROM; // ex: whatsapp:+14155238886

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
    'apikey': SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

async function getDistinctPhones() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/whatsapp_messages?select=phone&order=phone',
    { headers: sbHeaders() }
  );
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.map(function(r) { return r.phone; }).filter(function(p) {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
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
  return tokens.access_token;
}

async function getCalendarEventsToday(accessToken) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
  });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) { console.error('CALENDAR ERR:', JSON.stringify(data.error)); return []; }
  return data.items || [];
}

async function getRecentNotes() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?select=title,content,cluster&order=updated_at.desc&limit=5',
    { headers: sbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function formatEvents(events) {
  if (!events || events.length === 0) return 'Nenhum evento agendado para hoje.';
  return events.map(function(e) {
    const time = e.start && e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        })
      : 'dia todo';
    return '• ' + time + ' — ' + (e.summary || 'Sem título');
  }).join('\n');
}

function formatNotes(notes) {
  if (!notes || notes.length === 0) return 'Nenhuma nota recente.';
  return notes.map(function(n) {
    return '• ' + n.title + (n.content ? ': ' + n.content.substring(0, 80) + '...' : '');
  }).join('\n');
}

async function generateBriefing(eventsText, notesText) {
  const date = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo'
  });

  const system = 'Você é o Jarvis, assistente pessoal. Gere um briefing matinal em português, curto e motivador (máximo 200 palavras). Seja direto e prático.';

  const prompt =
    'Hoje é ' + date + '.\n\n' +
    'AGENDA DE HOJE:\n' + eventsText + '\n\n' +
    'NOTAS RECENTES DO VAULT:\n' + notesText + '\n\n' +
    'Gere um briefing matinal personalizado: cumprimente, resuma o dia, destaque algo relevante das notas e finalize com energia positiva.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 400,
      system:     system,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.content && data.content[0]) return data.content[0].text;
  console.error('CLAUDE BRIEFING ERR:', JSON.stringify(data));
  return null;
}

async function sendWhatsApp(to, body) {
  const toFormatted = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const res = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toFormatted, Body: body }),
    }
  );
  const data = await res.json();
  console.log('TWILIO SEND:', res.status, '| TO:', toFormatted, '| SID:', data.sid || data.code);
  return res.status === 201;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) {
    console.warn('BRIEFING: unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('BRIEFING CRON: iniciando', new Date().toISOString());

  const phones = await getDistinctPhones();
  console.log('BRIEFING: phones encontrados:', phones.length, phones);

  if (phones.length === 0) {
    return res.json({ ok: true, sent: 0, message: 'Nenhum usuário cadastrado.' });
  }

  const results = [];

  for (const phone of phones) {
    try {
      console.log('BRIEFING: processando', phone);

      let accessToken    = null;
      let calendarEvents = [];

      const tokenRow = await getGoogleTokens(phone);
      if (tokenRow) {
        try {
          accessToken = Date.now() >= tokenRow.expiry_date - 60000
            ? await refreshGoogleToken(phone, tokenRow.refresh_token)
            : tokenRow.access_token;
          calendarEvents = await getCalendarEventsToday(accessToken);
          console.log('BRIEFING: eventos', phone, calendarEvents.length);
        } catch (err) {
          console.error('BRIEFING GOOGLE ERR:', phone, err.message);
        }
      }

      const notes      = await getRecentNotes();
      const eventsText = formatEvents(calendarEvents);
      const notesText  = formatNotes(notes);
      const briefing   = await generateBriefing(eventsText, notesText);

      if (!briefing) {
        results.push({ phone, ok: false, reason: 'claude_null' });
        continue;
      }

      const sent = await sendWhatsApp(phone, briefing);
      results.push({ phone, ok: sent });

    } catch (err) {
      console.error('BRIEFING ERR:', phone, err.message);
      results.push({ phone, ok: false, reason: err.message });
    }
  }

  const sent = results.filter(function(r) { return r.ok; }).length;
  console.log('BRIEFING CRON: finalizado. Enviados:', sent, '/', phones.length);
  return res.json({ ok: true, sent, total: phones.length, results });
}
