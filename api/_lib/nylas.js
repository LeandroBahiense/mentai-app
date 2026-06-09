/**
 * Pallyum — camada de calendário Nylas v3 (Etapa 03)
 * Shape de SAÍDA compatível com api/_lib/google.js: getCalendarEventsNylas
 * devolve eventos no formato Google ({ id, summary, location, start:{dateTime|date} }),
 * plugando direto no sort (start.dateTime||start.date) e no formatCalendarEvents
 * existentes — sem formatter novo.
 *
 * Import inerte: nada executa até uma função ser chamada. Sem dependência de canal.
 *
 * ENV: NYLAS_API_URI (ex: https://api.us.nylas.com), NYLAS_API_KEY.
 * Tabela de grants: nylas_grants (lida via service-role, mesmo padrão do google_tokens).
 */

const NYLAS_API_URI = process.env.NYLAS_API_URI;
const NYLAS_API_KEY = process.env.NYLAS_API_KEY;

// OAuth (hosted auth). No método API-key, o client_secret na troca É a NYLAS_API_KEY.
const NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID;
const NYLAS_REDIRECT_URI = 'https://pallyum.com/api/auth/nylas-callback';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TZ = 'America/Sao_Paulo';

// Headers Supabase service-role — MESMO padrão de api/_lib/google.js (googleSbHeaders).
function nylasSbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  };
}

// ─── Helper de request à Nylas ────────────────────────────────────────────────
// Monta URL + query, aplica headers, parseia JSON. Em !res.ok: loga e LANÇA.
// Retorna o envelope { request_id, data } — callers descascam .data.
// Callers de LEITURA capturam e degradam pra [] (igual ao google.js); escritas propagam.
export async function nylasFetch(path, opts = {}) {
  const { method = 'GET', query, body } = opts;
  let url = NYLAS_API_URI + path;
  if (query) {
    const usp = new URLSearchParams();
    for (const k of Object.keys(query)) {
      const v = query[k];
      if (v !== undefined && v !== null) usp.append(k, String(v));
    }
    const qs = usp.toString();
    if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
  }
  const headers = {
    'Authorization': 'Bearer ' + NYLAS_API_KEY,
    'Accept': 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    console.error('NYLAS ERR ' + res.status, JSON.stringify(json));
    throw new Error('Nylas ' + res.status);
  }
  return json;
}

// ─── Auth: hosted connect + troca de code por grant ──────────────────────────
// Sem provider (Nylas mostra o seletor) e sem PKCE.
export function buildNylasAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     NYLAS_CLIENT_ID,
    redirect_uri:  NYLAS_REDIRECT_URI,
    response_type: 'code',
    state:         state,
  });
  return NYLAS_API_URI + '/v3/connect/auth?' + params.toString();
}

let _loggedExchange = false;
// Troca o code por grant. client_secret = NYLAS_API_KEY (método API-key).
// Retorna { grantId, email, provider }. Na 1ª execução loga a resposta crua
// (só nomes/valores não-sensíveis — a resposta NÃO contém o client_secret/key).
export async function exchangeCodeForGrant(code) {
  const res = await fetch(NYLAS_API_URI + '/v3/connect/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      code:          code,
      client_id:     NYLAS_CLIENT_ID,
      client_secret: NYLAS_API_KEY,
      redirect_uri:  NYLAS_REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }

  if (!_loggedExchange) {
    _loggedExchange = true;
    // Loga campos esperados + lista de chaves (sem valores sensíveis) p/ confirmar nomes.
    console.log('NYLAS EXCHANGE (1ª vez):', JSON.stringify({
      status:   res.status,
      grant_id: json && json.grant_id,
      email:    json && json.email,
      provider: json && json.provider,
      keys:     json ? Object.keys(json) : [],
    }));
  }

  if (!res.ok || !json || !json.grant_id) {
    console.error('NYLAS EXCHANGE ERR ' + res.status);
    throw new Error('Nylas token exchange falhou: ' + res.status);
  }
  return { grantId: json.grant_id, email: json.email, provider: json.provider };
}

// Revoga (deleta) um grant na Nylas. Best-effort: loga e retorna bool; NÃO lança.
export async function revokeGrant(grantId) {
  try {
    const res = await fetch(NYLAS_API_URI + '/v3/grants/' + encodeURIComponent(grantId), {
      method:  'DELETE',
      headers: { 'Authorization': 'Bearer ' + NYLAS_API_KEY, 'Accept': 'application/json' },
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    console.log('NYLAS REVOKE:', res.status, JSON.stringify(body));
    return res.ok;
  } catch (e) {
    console.error('NYLAS REVOKE ERR:', e.message);
    return false;
  }
}

// ─── Grants (Supabase) ────────────────────────────────────────────────────────
// Lê nylas_grants reusando EXATAMENTE o padrão/headers/envs do google_tokens.
export async function getAllNylasGrants(userId) {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/nylas_grants?user_id=eq.' + encodeURIComponent(userId) +
        '&status=eq.active' +
        '&select=id,email,provider,grant_id,is_primary,calendar_id,status' +
        '&order=is_primary.desc',
      { headers: nylasSbHeaders() }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('getAllNylasGrants error:', e.message);
    return [];
  }
}

// ─── Calendars ────────────────────────────────────────────────────────────────
// Interno: lista de calendars do grant (envelope descascado). Lança em erro.
async function _getCalendars(grantId) {
  const json = await nylasFetch('/v3/grants/' + encodeURIComponent(grantId) + '/calendars');
  return Array.isArray(json.data) ? json.data : [];
}

// id do calendar principal; fallback: primeiro próprio e gravável; fallback: primeiro.
export async function getPrimaryCalendarId(grantId) {
  try {
    const cals = await _getCalendars(grantId);
    if (cals.length === 0) return null;
    const primary = cals.find(function (c) { return c.is_primary === true; });
    if (primary) return primary.id;
    const owned = cals.find(function (c) { return c.is_owned_by_user && !c.read_only; });
    if (owned) return owned.id;
    return cals[0].id;
  } catch (e) {
    console.error('getPrimaryCalendarId error:', e.message);
    return null;
  }
}

// Se o grant já traz calendar_id, usa; senão resolve o principal.
export async function resolveCalendarId(grant) {
  if (grant && grant.calendar_id) return grant.calendar_id;
  return await getPrimaryCalendarId(grant.grant_id);
}

// ─── Events: listagem crua (interna) ──────────────────────────────────────────
// Janela [startEpochS, endEpochS]. Retorna { calendarId, events: [crus Nylas] }.
async function _listEventsRaw(grant, startEpochS, endEpochS) {
  const calendarId = await resolveCalendarId(grant);
  if (!calendarId) return { calendarId: null, events: [] };
  const json = await nylasFetch('/v3/grants/' + encodeURIComponent(grant.grant_id) + '/events', {
    query: { calendar_id: calendarId, start: startEpochS, end: endEpochS, limit: 50 },
  });
  return { calendarId, events: Array.isArray(json.data) ? json.data : [] };
}

// Mapeia o "when" cru da Nylas para o sub-objeto start do Google.
function _whenToGoogleStart(when) {
  if (!when) return {};
  if (when.object === 'timespan') {
    return { dateTime: new Date(when.start_time * 1000).toISOString(), timeZone: when.start_timezone };
  }
  if (when.object === 'date')     return { date: when.date };
  if (when.object === 'datespan') return { date: when.start_date };
  return {};
}

// ─── Leitura: eventos no SHAPE DO GOOGLE ──────────────────────────────────────
export async function getCalendarEventsNylas(grant, daysAhead = 8) {
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const endS = nowS + daysAhead * 86400;
    const { events } = await _listEventsRaw(grant, nowS, endS);
    const mapped = events.map(function (ev) {
      return {
        id:       ev.id,
        summary:  ev.title || '',
        location: ev.location,
        start:    _whenToGoogleStart(ev.when),
      };
    });
    console.log('NYLAS CAL EVENTS:', mapped.length);
    return mapped;
  } catch (e) {
    console.error('getCalendarEventsNylas error:', e.message);
    return [];
  }
}

// ─── Escrita: create ──────────────────────────────────────────────────────────
export async function createCalendarEventNylas(grant, title, datetime, description) {
  const calendarId = await resolveCalendarId(grant);
  if (!calendarId) {
    console.error('NYLAS CAL CREATE: sem calendar_id resolvido — abortando', title);
    return null;
  }
  // Aborta se o calendar resolvido for read_only (ex.: agenda de feriados).
  try {
    const cals = await _getCalendars(grant.grant_id);
    const cal = cals.find(function (c) { return c.id === calendarId; });
    if (cal && cal.read_only) {
      console.error('NYLAS CAL CREATE: calendar read_only — abortando', calendarId, '|', title);
      return null;
    }
  } catch (e) { /* não dá pra checar read_only → segue; a API barra se for o caso */ }

  const start = new Date(datetime);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const json = await nylasFetch('/v3/grants/' + encodeURIComponent(grant.grant_id) + '/events', {
    method: 'POST',
    query: { calendar_id: calendarId },
    body: {
      title:       title,
      description: description || '',
      when: {
        start_time:     Math.floor(start.getTime() / 1000),
        end_time:       Math.floor(end.getTime() / 1000),
        start_timezone: TZ,
        end_timezone:   TZ,
      },
    },
  });
  console.log('NYLAS CAL CREATE:', 200, '|', title);
  return json.data;
}

// ─── Busca de evento por título (+ desambiguação por hora) ────────────────────
// Sem datetime → primeiro match de título. Com datetime → exige match ±60s, senão null.
// (Mesma lógica do findCalendarEvent do google.js.) Retorna { eventId, calendarId } | null.
export async function findCalendarEventNylas(grant, title, datetime) {
  try {
    const base = datetime ? new Date(datetime) : new Date();
    const baseMs = isNaN(base.getTime()) ? Date.now() : base.getTime();
    const startS = Math.floor((baseMs - 30 * 86400000) / 1000);
    const endS   = Math.floor((baseMs + 60 * 86400000) / 1000);
    const { calendarId, events } = await _listEventsRaw(grant, startS, endS);
    if (!calendarId) return null;

    const tl = (title || '').toLowerCase();
    const matches = events.filter(function (e) { return (e.title || '').toLowerCase().indexOf(tl) >= 0; });
    console.log('NYLAS FIND:', matches.map(function (e) { return e.title; }));
    if (matches.length === 0) return null;

    if (datetime) {
      const target = new Date(datetime).getTime();
      const exact = matches.find(function (e) {
        const w = e.when || {};
        let st = null;
        if (w.start_time) st = w.start_time * 1000;
        else if (w.date) st = new Date(w.date + 'T00:00:00-03:00').getTime();
        return st !== null && Math.abs(st - target) < 60000;
      });
      if (exact) return { eventId: exact.id, calendarId };
      console.log('NYLAS FIND: nenhum no horário', datetime);
      return null;
    }
    return { eventId: matches[0].id, calendarId };
  } catch (e) {
    console.error('findCalendarEventNylas error:', e.message);
    return null;
  }
}

// ─── Escrita: update (find → PUT novo when) ───────────────────────────────────
export async function updateCalendarEventNylas(grant, title, newDatetime) {
  const found = await findCalendarEventNylas(grant, title);
  if (!found) { console.log('NYLAS CAL UPDATE: evento não encontrado', '|', title); return false; }
  const start = new Date(newDatetime);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const json = await nylasFetch('/v3/grants/' + encodeURIComponent(grant.grant_id) + '/events/' + encodeURIComponent(found.eventId), {
    method: 'PUT',
    query: { calendar_id: found.calendarId },
    body: {
      when: {
        start_time:     Math.floor(start.getTime() / 1000),
        end_time:       Math.floor(end.getTime() / 1000),
        start_timezone: TZ,
        end_timezone:   TZ,
      },
    },
  });
  console.log('NYLAS CAL UPDATE:', 200, '|', title);
  return json;
}

// ─── Escrita: delete (find → DELETE) ──────────────────────────────────────────
export async function deleteCalendarEventNylas(grant, title, datetime) {
  const found = await findCalendarEventNylas(grant, title, datetime);
  if (!found) { console.log('NYLAS CAL DELETE: evento não encontrado', '|', title); return false; }
  await nylasFetch('/v3/grants/' + encodeURIComponent(grant.grant_id) + '/events/' + encodeURIComponent(found.eventId), {
    method: 'DELETE',
    query: { calendar_id: found.calendarId },
  });
  console.log('NYLAS CAL DELETE:', 200, '|', title);
  return true;
}
