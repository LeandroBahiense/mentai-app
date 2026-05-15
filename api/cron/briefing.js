const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const TWILIO_SID       = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM      = process.env.TWILIO_WHATSAPP_FROM;

function anonHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };
}

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SVC_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SVC_KEY,
  };
}

// ─── Supabase: usuários ───────────────────────────────────────────────────────

async function getDistinctPhones() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/whatsapp_messages?select=phone&order=phone',
    { headers: anonHeaders() }
  );
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.map(r => r.phone).filter(p => {
    if (!p || seen.has(p)) return false;
    seen.add(p); return true;
  });
}

async function getGoogleTokens(phone) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?phone=eq.' + encodeURIComponent(phone) + '&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getGoogleTokensByUserId(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?user_id=eq.' + userId + '&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getUserPrefs(userId) {
  if (!userId) return null;
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/user_preferences?user_id=eq.' + userId + '&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getPrefsForHour(horaAtual) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/user_preferences?briefing_hora=eq.' + encodeURIComponent(horaAtual) +
    '&select=user_id,display_name,assistant_name,briefing_hora',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function getPhoneByUserId(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?user_id=eq.' + userId + '&select=phone&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0].phone : null;
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

async function refreshGoogleToken(phone, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
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
      method:  'PATCH',
      headers: svcHeaders(),
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
    timeMin:      start.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '8',
  });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) { console.error('CALENDAR ERR:', JSON.stringify(data.error)); return []; }
  return data.items || [];
}

// ─── Vault: notas urgentes ────────────────────────────────────────────────────

async function getUrgentNotes(userId) {
  if (!userId) return [];
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/notes?user_id=eq.' + userId +
    '&status=eq.urgente&in_trash=is.false&select=title,folder&order=updated_at.desc&limit=8',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ─── Formatação ───────────────────────────────────────────────────────────────

function formatEvents(events) {
  if (!events || events.length === 0) return 'Nenhum evento hoje';
  return events.map(e => {
    const time = e.start && e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
        })
      : 'dia todo';
    return '• ' + time + ' — ' + (e.summary || 'Sem título');
  }).join('\n');
}

function formatUrgentNotes(notes) {
  if (!notes || notes.length === 0) return 'Nenhuma urgência — bom dia tranquilo!';
  return notes.map(n => '• ' + n.title).join('\n');
}

// ─── Claude: gera frase do Jarvis ─────────────────────────────────────────────

async function generateJarvisLine(displayName, assistantName, eventsText, urgentText) {
  const date = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo',
  });

  const system =
    'Você é ' + (assistantName || 'Jarvis') + ', assistente pessoal de ' + (displayName || 'seu usuário') + '. ' +
    'Responda APENAS com uma única frase curta (máx 20 palavras), motivadora e direta, ' +
    'baseada no contexto da agenda e urgências do dia. Sem saudação, sem introdução, só a frase.';

  const prompt =
    'Hoje é ' + date + '.\n' +
    'Agenda: ' + eventsText + '\n' +
    'Urgentes: ' + urgentText + '\n\n' +
    'Gere a frase do dia para ' + (displayName || 'o usuário') + '.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 80,
      system,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.content && data.content[0]) return data.content[0].text.trim();
  console.error('CLAUDE ERR:', JSON.stringify(data));
  return null;
}

// ─── Monta mensagem final ─────────────────────────────────────────────────────

function buildMessage(displayName, assistantName, eventsText, urgentText, jarvisLine) {
  const hour = new Date().toLocaleString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });

  const name  = displayName   || 'você';
  const lines = [];

  lines.push('☀️ *Bom dia, ' + name + '!*');
  lines.push('');
  lines.push('📅 *Agenda de hoje*');
  lines.push(eventsText);
  lines.push('');
  lines.push('⚡ *Urgentes*');
  lines.push(urgentText);

  if (jarvisLine) {
    lines.push('');
    lines.push('✦ _' + jarvisLine + '_');
  }

  return lines.join('\n');
}

// ─── Twilio ───────────────────────────────────────────────────────────────────

async function sendWhatsApp(to, body) {
  const toFormatted = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const res = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json',
    {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toFormatted, Body: body }),
    }
  );
  const data = await res.json();
  console.log('TWILIO:', res.status, '| TO:', toFormatted, '| SID:', data.sid || data.code);
  return res.status === 201;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) {
    console.warn('BRIEFING: unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('BRIEFING CRON: start', new Date().toISOString());

  // hora atual em Brasília no formato "HH:MM"
  const now = new Date();
  const horaAtual = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).format(now).substring(0, 5);

  console.log('BRIEFING: hora Brasília:', horaAtual);

  // usuários cujo briefing_hora bate com a hora atual
  const prefs = await getPrefsForHour(horaAtual);
  console.log('BRIEFING: usuários nesta hora:', prefs.length);

  if (prefs.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, msg: 'Nenhum briefing nesta hora.' });
  }

  const results = [];

  for (const pref of prefs) {
    const { user_id: userId, display_name: displayName, assistant_name: assistantName } = pref;

    try {
      console.log('BRIEFING: processando user_id', userId);

      // phone do usuário via google_tokens
      const phone = await getPhoneByUserId(userId);
      if (!phone) {
        console.warn('BRIEFING: sem phone para user_id', userId);
        results.push({ userId, ok: false, reason: 'sem_phone' });
        continue;
      }

      // Google Calendar — busca tokens por user_id (OAuth flow)
      let calendarEvents = [];
      const tokenRow = await getGoogleTokensByUserId(userId);
      if (tokenRow) {
        try {
          const accessToken = Date.now() >= (tokenRow.expiry_date - 60000)
            ? await refreshGoogleToken(phone, tokenRow.refresh_token)
            : tokenRow.access_token;
          calendarEvents = await getCalendarEventsToday(accessToken);
        } catch (err) {
          console.error('GOOGLE ERR:', userId, err.message);
        }
      }

      // Notas urgentes
      const urgentNotes = await getUrgentNotes(userId);

      // Formata
      const eventsText = formatEvents(calendarEvents);
      const urgentText = formatUrgentNotes(urgentNotes);

      // Frase do Jarvis via Claude
      const jarvisLine = await generateJarvisLine(
        displayName, assistantName || 'Jarvis', eventsText, urgentText
      );

      // Monta e envia
      const message = buildMessage(
        displayName, assistantName || 'Jarvis', eventsText, urgentText, jarvisLine
      );
      const sent = await sendWhatsApp(phone, message);
      results.push({ userId, phone, ok: sent });

    } catch (err) {
      console.error('BRIEFING ERR:', userId, err.message);
      results.push({ userId, ok: false, reason: err.message });
    }
  }

  const sent = results.filter(r => r.ok).length;
  console.log('BRIEFING CRON: done. Enviados:', sent, '/', prefs.length);
  return res.json({ ok: true, sent, total: prefs.length, results });
}
