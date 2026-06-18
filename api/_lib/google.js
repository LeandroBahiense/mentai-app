/**
 * Pallyum — camada Google (calendário + conta + token)
 * Compartilhada por whatsapp.js e chat.js. Isolada de propósito: é a camada
 * que a Etapa 03 (Nylas) vai reescrever. Lógica de serviço pura — sem
 * dependências de canal (WhatsApp/web).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_TZ = 'America/Sao_Paulo';

function googleSbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  };
}

// ─── Conta + token ────────────────────────────────────────────────────────────

export async function getAllGoogleAccounts(userId, phone) {
  const filter = userId
    ? 'user_id=eq.' + encodeURIComponent(userId)
    : 'phone=eq.' + encodeURIComponent(phone);
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?' + filter + '&order=is_primary.desc',
    { headers: googleSbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function refreshAccountToken(account) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
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
  await fetch(SUPABASE_URL + '/rest/v1/google_tokens?id=eq.' + account.id, {
    method: 'PATCH',
    headers: googleSbHeaders(),
    body: JSON.stringify({
      access_token: tokens.access_token,
      expiry_date:  Date.now() + tokens.expires_in * 1000,
      updated_at:   new Date().toISOString(),
    }),
  });
  return tokens.access_token;
}

export async function ensureAccountToken(account) {
  if (Date.now() >= account.expiry_date - 60000) return await refreshAccountToken(account);
  return account.access_token;
}

// ─── Google Calendar (CRUD) ───────────────────────────────────────────────────

export async function getCalendarEvents(accessToken, daysAhead = 8) {
  const hojeBR = new Intl.DateTimeFormat('en-CA', {
    timeZone: USER_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const timeMin = hojeBR + 'T00:00:00-03:00';
  const timeMax = new Date(Date.now() + daysAhead * 86400000).toISOString();
  const params = new URLSearchParams({
    timeMin, timeMax,
    singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
    timeZone: 'America/Sao_Paulo',
  });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (data.error) { console.error('CALENDAR READ ERR:', JSON.stringify(data.error)); return []; }
  console.log('CALENDAR EVENTS:', (data.items || []).length);
  return data.items || [];
}

export async function createCalendarEvent(accessToken, title, datetime, description, attendees) {
  const start = new Date(datetime);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const guests = Array.isArray(attendees) ? attendees.filter(Boolean) : [];
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events' + (guests.length ? '?sendUpdates=all' : '');
  const body = {
    summary:     title,
    description: description || '',
    start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
    end:   { dateTime: end.toISOString(),   timeZone: 'America/Sao_Paulo' },
  };
  if (guests.length) body.attendees = guests.map(function (e) { return { email: e }; });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('CALENDAR CREATE:', res.status, '|', title);
  return data;
}

export async function findCalendarEvent(accessToken, title, datetime) {
  const now    = new Date();
  const past   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    q: title, timeMin: past.toISOString(), timeMax: future.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
  });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  const items = data.items || [];
  console.log('CALENDAR FIND:', items.map(function(e) { return e.summary + ' @ ' + ((e.start && (e.start.dateTime || e.start.date)) || '?'); }));
  if (datetime) {
    const target = new Date(datetime).getTime();
    const match = items.find(function(e) {
      const s = e.start && (e.start.dateTime || e.start.date);
      return s && Math.abs(new Date(s).getTime() - target) < 60000;
    });
    if (match) return match;
    console.log('NO EVENT MATCHES DATETIME:', datetime);
    return null;
  }
  return items.length > 0 ? items[0] : null;
}

export async function updateCalendarEvent(accessToken, title, newDatetime) {
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

export async function deleteCalendarEvent(accessToken, title, datetime) {
  const event = await findCalendarEvent(accessToken, title, datetime);
  if (!event) { console.log('EVENT NOT FOUND FOR DELETE:', title); return false; }
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + event.id,
    { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  console.log('CALENDAR DELETE STATUS:', res.status, '|', event.summary);
  return res.status === 204;
}

// ─── Endereçamento por ID (sem find por título) ───────────────────────────────
// Pega 1 evento pelo id nativo. Retorna o objeto do evento | null.
export async function getGoogleEventById(accessToken, eventId) {
  try {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(eventId),
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    const data = await res.json();
    if (data.error) { console.error('GOOGLE GET EVENT ERR:', JSON.stringify(data.error)); return null; }
    return data;
  } catch (e) {
    console.error('getGoogleEventById error:', e.message);
    return null;
  }
}

// Atualiza SÓ o horário de um evento endereçado por id (start + 1h). Retorna bool.
export async function patchGoogleEventTime(accessToken, eventId, newDatetimeISO) {
  const start = new Date(newDatetimeISO);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(eventId),
    {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
        end:   { dateTime: end.toISOString(),   timeZone: 'America/Sao_Paulo' },
      }),
    }
  );
  console.log('GOOGLE CAL PATCH (by id):', res.status, '|', eventId);
  return res.status >= 200 && res.status < 300;
}

// Substitui a lista de convidados de um evento (by id) e notifica todos. attendees: array de {email,...}.
export async function patchGoogleEventAttendees(accessToken, eventId, attendees) {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(eventId) + '?sendUpdates=all',
    {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendees: Array.isArray(attendees) ? attendees : [] }),
    }
  );
  console.log('GOOGLE CAL PATCH attendees (by id):', res.status, '|', eventId);
  return res.status >= 200 && res.status < 300;
}

// Apaga um evento endereçado por id. sendUpdates: 'none' | 'all' | 'externalOnly'. Retorna bool.
export async function deleteGoogleEventById(accessToken, eventId, sendUpdates = 'none') {
  const params = new URLSearchParams({ sendUpdates: sendUpdates });
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(eventId) + '?' + params,
    { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  console.log('GOOGLE CAL DELETE (by id):', res.status, '|', eventId, '| sendUpdates:', sendUpdates);
  return res.status === 204;
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

export async function getGmailMessages(accessToken) {
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

export function formatCalendarEvents(events) {
  if (!events || events.length === 0) return 'Nenhum evento nos próximos dias.';
  const hojeBR = new Intl.DateTimeFormat('en-CA', {
    timeZone: USER_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  return events.map(function(e) {
    if (e.start.dateTime) {
      const dt      = new Date(e.start.dateTime);
      const diaSem  = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, weekday: 'short' }).format(dt).replace('.', '');
      const dataBR  = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, day: '2-digit', month: '2-digit' }).format(dt);
      const horaBR  = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, hour: '2-digit', minute: '2-digit' }).format(dt);
      const eventoDia = new Intl.DateTimeFormat('en-CA', { timeZone: USER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
      const label   = eventoDia === hojeBR
        ? diaSem + ' ' + horaBR
        : diaSem + ' ' + dataBR + ' ' + horaBR;
      return '- ' + label + ' — ' + (e.summary || 'Sem título');
    } else {
      const dt      = new Date(e.start.date + 'T00:00:00-03:00');
      const diaSem  = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, weekday: 'short' }).format(dt).replace('.', '');
      const dataBR  = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, day: '2-digit', month: '2-digit' }).format(dt);
      return '- ' + diaSem + ' ' + dataBR + ' (dia todo) — ' + (e.summary || 'Sem título');
    }
  }).join('\n');
}

export function formatGmailMessages(messages) {
  if (!messages || messages.length === 0) return 'Nenhum email não lido.';
  return messages.map(function(m, i) {
    return (i + 1) + '. De: ' + m.from + '\n   Assunto: ' + m.subject + '\n   ' + m.snippet;
  }).join('\n\n');
}
