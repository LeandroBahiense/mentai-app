const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const TWILIO_SID              = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN            = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM             = process.env.TWILIO_WHATSAPP_FROM;
const BRIEFING_TEMPLATE_SID   = process.env.TWILIO_BRIEFING_TEMPLATE_SID;

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
    SUPABASE_URL + '/rest/v1/phone_users?user_id=eq.' + encodeURIComponent(userId) + '&select=phone&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0].phone : null;
}

async function getPhoneRow(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/phone_users?user_id=eq.' +
      encodeURIComponent(userId) + '&select=phone,last_inbound_at&limit=1',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
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
  const hojeBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = new Date(hojeBR + 'T00:00:00-03:00');
  const end   = new Date(hojeBR + 'T23:59:59-03:00');
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

async function getAllGoogleAccountsByUserId(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?user_id=eq.' + encodeURIComponent(userId) + '&order=is_primary.desc',
    { headers: svcHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function refreshAccountToken(account) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: account.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const tokens = await res.json();
  if (tokens.error) throw new Error('Refresh falhou: ' + tokens.error);
  await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?id=eq.' + encodeURIComponent(account.id),
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

async function ensureAccountToken(account) {
  if (Date.now() >= (account.expiry_date - 60000)) return await refreshAccountToken(account);
  return account.access_token;
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
    'Escreva de 2 a 3 frases curtas (máx 50 palavras no total), motivadoras e diretas, ' +
    'como um foco do dia personalizado baseado na agenda e nas urgências. ' +
    'Mencione o evento mais importante se houver. Sem saudação, sem introdução, só as frases.';

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
      max_tokens: 150,
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

function buildMessage(displayName, eventsText, urgentText, urgentCount, jarvisLine) {
  const dataBR = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo',
  }).replace('-feira', '');
  const dataCap = dataBR.charAt(0).toUpperCase() + dataBR.slice(1);

  const name  = displayName || 'você';
  const lines = [];

  lines.push('☀️ *Bom dia, ' + name + '!*');
  lines.push('_' + dataCap + '_');
  lines.push('');
  lines.push('📅 *Agenda de hoje*');
  lines.push(eventsText);
  lines.push('');

  if (urgentCount > 0) {
    lines.push('⚡ *Você tem ' + (urgentCount === 1 ? '1 nota Urgente' : urgentCount + ' notas Urgentes') + ':*');
    lines.push(urgentText);
  } else {
    lines.push('⚡ *Nenhuma urgência — dia tranquilo!*');
  }

  if (jarvisLine) {
    lines.push('');
    lines.push('✦ *Foco do dia*');
    lines.push('_' + jarvisLine + '_');
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

async function sendWhatsAppTemplate(to, contentSid, variables) {
  const toFormatted = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const res = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json',
    {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: TWILIO_FROM,
        To: toFormatted,
        ContentSid: contentSid,
        ContentVariables: JSON.stringify(variables),
      }),
    }
  );
  const data = await res.json();
  console.log('TWILIO TEMPLATE:', res.status, '| TO:', toFormatted, '| SID:', data.sid || data.code, '| ERR:', data.message || 'none');
  return res.status === 201;
}

async function saveBriefingCache(userId, texto, nCompromissos, nUrgentes) {
  try {
    await fetch(
      SUPABASE_URL + '/rest/v1/briefing_cache?on_conflict=user_id',
      {
        method: 'POST',
        headers: { ...svcHeaders(), 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: userId, texto,
          n_compromissos: nCompromissos, n_urgentes: nUrgentes,
          gerado_em: new Date().toISOString(),
        }),
      }
    );
  } catch (e) { console.error('saveBriefingCache err:', e.message); }
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
  // Só a HORA cheia em Brasília (00–23). hourCycle 'h23' + formatToParts
  // evita o bug "24:00" da meia-noite e ruído de locale. Ignoramos o minuto
  // de propósito: o cron da Vercel pode disparar minutos após o :00, e
  // briefing_hora é sempre hora cheia ("HH:00").
  const hh = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour:     '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).find(p => p.type === 'hour').value;
  const horaAtual = hh + ':00';   // ex.: "07:00"

  console.log('BRIEFING: hora Brasília (cheia):', horaAtual);

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

      // phone + last_inbound_at para decidir se a janela de 24h está aberta
      const prow = await getPhoneRow(userId);
      if (!prow || !prow.phone) {
        console.warn('BRIEFING: sem phone para user_id', userId);
        results.push({ userId, ok: false, reason: 'sem_phone' });
        continue;
      }
      const phone          = prow.phone;
      const lastInboundAt  = prow.last_inbound_at;

      // Google Calendar — agrega TODAS as contas do usuário (multi-conta)
      let calendarEvents = [];
      const accounts = await getAllGoogleAccountsByUserId(userId);
      for (const acc of accounts) {
        try {
          const accessToken = await ensureAccountToken(acc);
          const evs = await getCalendarEventsToday(accessToken);
          calendarEvents = calendarEvents.concat(evs);
        } catch (err) {
          console.error('BRIEFING CAL ERR:', acc.email, err.message);
        }
      }
      calendarEvents.sort(function (a, b) {
        return new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date);
      });
      console.log('BRIEFING: eventos agregados:', calendarEvents.length, '| contas:', accounts.length);

      // Notas urgentes
      const urgentNotes = await getUrgentNotes(userId);

      // Formata
      const eventsText = formatEvents(calendarEvents);
      const urgentText = formatUrgentNotes(urgentNotes);

      // Frase do Jarvis via Claude
      const jarvisLine = await generateJarvisLine(
        displayName, assistantName || 'Jarvis', eventsText, urgentText
      );

      // Monta mensagem completa
      const message = buildMessage(
        displayName, eventsText, urgentText, urgentNotes.length, jarvisLine
      );

      // grava o cache sempre — o toque do botão VER_BRIEFING serve daqui
      await saveBriefingCache(userId, message, calendarEvents.length, urgentNotes.length);

      // janela de 24h: dentro → texto livre; fora / nunca interagiu → template fino
      const within24h = lastInboundAt &&
        (Date.now() - new Date(lastInboundAt).getTime() < 24 * 60 * 60 * 1000);
      let sent;
      if (within24h) {
        sent = await sendWhatsApp(phone, message);
      } else {
        if (!BRIEFING_TEMPLATE_SID) {
          console.error('BRIEFING: TWILIO_BRIEFING_TEMPLATE_SID ausente — fora da janela, não envia');
          sent = false;
        } else {
          sent = await sendWhatsAppTemplate(phone, BRIEFING_TEMPLATE_SID, {
            '1': String(calendarEvents.length),
            '2': String(urgentNotes.length),
          });
        }
      }
      results.push({ userId, phone, ok: sent, mode: within24h ? 'freeform' : 'template' });

    } catch (err) {
      console.error('BRIEFING ERR:', userId, err.message);
      results.push({ userId, ok: false, reason: err.message });
    }
  }

  const sent = results.filter(r => r.ok).length;
  console.log('BRIEFING CRON: done. Enviados:', sent, '/', prefs.length);
  return res.json({ ok: true, sent, total: prefs.length, results });
}
