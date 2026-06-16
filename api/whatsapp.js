import { getModelForUser, calculateCooldown, trackUsage, routeModel, checkVisionQuota, incrementVisionUsage, isPlanActive } from './_lib/plans.js';
import { searchRelevantNotes, buildRagContext } from './_lib/embeddings.js';
import { getAllGoogleAccounts, ensureAccountToken, getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, getGmailMessages, formatCalendarEvents, formatGmailMessages } from './_lib/google.js';
import { getAllNylasGrants, getCalendarEventsNylas, createCalendarEventNylas, updateCalendarEventNylas, deleteCalendarEventNylas } from './_lib/nylas.js';
import { askClaudeTools, EVENT_TOOLS, NOTE_TOOLS, createNote, updateNote, deleteNote } from './_lib/agent.js';
import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM;

const USER_TZ = 'America/Sao_Paulo'; // futuramente: user.timezone || 'America/Sao_Paulo' — fuso por usuário ao internacionalizar

function validateTwilioSignature(token, signature, url, params) {
  const keys = Object.keys(params || {}).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

function toBase64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signState(payload) {
  const b64 = toBase64url(JSON.stringify(payload));
  const sig = toBase64url(createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest());
  return b64 + '.' + sig;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function dataHojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// Normaliza telefone para o formato canônico BR E.164: +55 + DDD + 9 + 8 dígitos.
// Obs: regra BR-cêntrica (DDD + nono dígito). Números internacionais precisariam
// de tratamento próprio no futuro — hoje todos os usuários são BR.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');   // só dígitos
  if (!d) return '';
  if (!d.startsWith('55')) d = '55' + d;          // garante o código do país
  const ddd = d.slice(2, 4);
  let sub = d.slice(4);
  if (sub.length === 8) sub = '9' + sub;          // insere o 9 do celular se faltar
  return '+55' + ddd + sub;                        // ex.: +5547997443333
}

async function sendWhatsApp(to, body) {
  const toFormatted = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  console.log('ENVIANDO RESPOSTA | TO:', toFormatted, '| FROM:', TWILIO_FROM);
  const sendRes = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toFormatted, Body: body }).toString(),
    }
  );
  const sendData = await sendRes.json();
  console.log(
    'TWILIO SEND STATUS:', sendRes.status,
    '| SID:', sendData.sid || 'none',
    '| STATUS:', sendData.status || 'none',
    '| ERROR_CODE:', sendData.error_code || 'none',
    '| ERROR:', sendData.message || 'none'
  );
  if (sendRes.status !== 201) {
    console.error('TWILIO SEND FAILED — FULL RESPONSE:', JSON.stringify(sendData));
  }
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

// ─── Transcrição de Reunião ───────────────────────────────────────────────────

function detectMeetingTranscript(text) {
  const t = (text || '').trim();

  // Comando de agenda (verbo de marcar + referência de tempo, mensagem curta) NUNCA é ata
  const ehComandoAgenda =
    /\b(marc|agend|cri|coloc|adicion|marque|agende)/i.test(t) &&
    /\b(amanh|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|meio-dia|meia-noite|\d{1,2}\s*h\b|\d{1,2}:\d{2})/i.test(t);
  if (ehComandoAgenda && t.length < 200) return false;

  // Transcrição de verdade: "Nome:" no início de pelo menos 2 linhas
  const falas = (t.match(/^[A-ZÀ-Úa-záéíóúâêôãõü][^\n:]{1,40}:/gm) || []).length;
  if (falas >= 2) return true;

  // Palavras-chave de reunião só contam em texto longo (ata/transcrição colada)
  const temPalavraChave = /transcri[çc][aã]o|reuni[aã]o|meeting|ata\b|call\b/i.test(t);
  return temPalavraChave && t.length >= 200;
}

async function processMeetingTranscript(transcriptText, userId, model) {
  const extractPrompt = [
    'Analise esta transcrição de reunião e extraia as informações estruturadas.',
    'Responda APENAS com JSON:',
    '{',
    '  "title": "título da reunião",',
    '  "participants": ["nome1", "nome2"],',
    '  "decisions": ["decisão 1", "decisão 2"],',
    '  "actions": ["ação 1 - responsável", "ação 2 - responsável"],',
    '  "summary": "resumo executivo em 3-4 linhas"',
    '}',
  ].join('\n');

  const raw = await askClaude(extractPrompt, [{ role: 'user', content: transcriptText }], model);
  if (!raw) throw new Error('Claude não retornou dados da transcrição');

  const cleaned = raw
    .replace(/```json\n?|\n?```/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
  const data = JSON.parse(cleaned);
  console.log('TRANSCRIPT PARSED:', data.title, '| PARTICIPANTS:', (data.participants || []).length);

  // Formata o conteúdo em markdown estruturado a partir do JSON extraído
  const noteContent =
    '## Participantes\n' +
    (data.participants || []).map(function(p) { return '- ' + p; }).join('\n') + '\n\n' +
    '## Decisões\n' +
    (data.decisions || []).map(function(d) { return '- ' + d; }).join('\n') + '\n\n' +
    '## Próximas Ações\n' +
    (data.actions || []).map(function(a) { return '- [ ] ' + a; }).join('\n') + '\n\n' +
    '## Resumo\n' +
    (data.summary || '');

  const title = data.title || ('Reunião ' + new Date().toLocaleDateString('pt-BR'));
  await createNote({
    title:   title,
    content: noteContent,
    folder:  'reunioes',
    cluster: 'equipe',
    tags:    ['reunião', 'transcrição'],
    user_id: userId,
  });
  console.log('MEETING NOTE CREATED:', title);

  return data;
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

async function getAssistantName(userId) {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/user_preferences?user_id=eq.' +
        encodeURIComponent(userId) + '&select=assistant_name&limit=1',
      { headers: googleSbHeaders() }
    );
    const data = await res.json();
    const name = Array.isArray(data) && data.length > 0 ? data[0].assistant_name : null;
    return (name && name.trim()) ? name.trim() : 'Jarvis';
  } catch (e) {
    console.error('getAssistantName err:', e.message);
    return 'Jarvis';
  }
}

async function getBriefingCache(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/briefing_cache?user_id=eq.' +
      encodeURIComponent(userId) + '&select=texto&limit=1',
    { headers: googleSbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0].texto : null;
}

async function touchLastInbound(phone) {
  try {
    await fetch(
      SUPABASE_URL + '/rest/v1/phone_users?phone=eq.' + encodeURIComponent(phone),
      {
        method: 'PATCH',
        headers: { ...googleSbHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ last_inbound_at: new Date().toISOString() }),
      }
    );
  } catch (e) {
    console.error('touchLastInbound err:', e.message);
  }
}

async function getGoogleTokens(phone, userId) {
  const filter = userId
    ? 'user_id=eq.' + encodeURIComponent(userId)
    : 'phone=eq.' + encodeURIComponent(phone);
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/google_tokens?' + filter + '&limit=1',
    { headers: googleSbHeaders() }
  );
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0];
  // Binding tardio: se encontrou por user_id mas phone ainda está vazio, popula
  if (userId && !row.phone && phone) {
    fetch(SUPABASE_URL + '/rest/v1/google_tokens?user_id=eq.' + encodeURIComponent(userId), {
      method: 'PATCH',
      headers: googleSbHeaders(),
      body: JSON.stringify({ phone: phone }),
    }).catch(function(e) { console.error('BIND PHONE TO TOKEN ERR:', e.message); });
  }
  return row;
}

async function refreshGoogleToken(phone, refreshToken, userId) {
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

  const filter = userId
    ? 'user_id=eq.' + encodeURIComponent(userId)
    : 'phone=eq.' + encodeURIComponent(phone);

  await fetch(SUPABASE_URL + '/rest/v1/google_tokens?' + filter, {
    method: 'PATCH',
    headers: googleSbHeaders(),
    body: JSON.stringify({
      access_token: tokens.access_token,
      expiry_date:  Date.now() + tokens.expires_in * 1000,
      updated_at:   new Date().toISOString(),
    }),
  });
  console.log('GOOGLE TOKEN REFRESHED:', userId || phone);
  return tokens.access_token;
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

// ─── Upload de mídia (imagens / documentos) ──────────────────────────────────

function mimeToExt(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'video/mp4': 'mp4', 'video/3gpp': '3gp',
  };
  return map[mime] || mime.split('/')[1] || 'bin';
}

async function uploadMediaToStorage(mediaUrl, mediaType, phone, userId) {
  // 1. Baixa o arquivo do Twilio com autenticação Basic
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const fileRes = await fetch(mediaUrl, { headers: { 'Authorization': 'Basic ' + auth } });
  if (!fileRes.ok) throw new Error('Erro ao baixar mídia do Twilio: ' + fileRes.status);
  const fileBuffer = await fileRes.arrayBuffer();

  const ext       = mimeToExt(mediaType);
  const timestamp = Date.now();
  const folder    = userId || ('phone-' + phone.replace(/\D/g, ''));
  const path      = folder + '/whatsapp/' + timestamp + '.' + ext;

  console.log('UPLOAD MEDIA:', path, '|', fileBuffer.byteLength, 'bytes');

  // 2. Upload para o Supabase Storage
  const storageUrl = SUPABASE_URL + '/storage/v1/object/mentai-files/' + path;
  const upRes = await fetch(storageUrl, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type':  mediaType,
      'x-upsert':      'true',
    },
    body: fileBuffer,
  });
  if (!upRes.ok) {
    const upErr = await upRes.text();
    throw new Error('Erro no upload Storage: ' + upRes.status + ' ' + upErr);
  }
  console.log('STORAGE UPLOAD OK:', upRes.status, path);

  // 3. Gera URL assinada válida por 1 hora
  const signRes = await fetch(
    SUPABASE_URL + '/storage/v1/object/sign/mentai-files/' + path,
    {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    }
  );
  const signData = await signRes.json();
  const signedUrl = signData.signedURL
    ? SUPABASE_URL + '/storage/v1' + signData.signedURL
    : null;
  console.log('SIGNED URL:', signedUrl ? 'OK' : 'FAILED');

  // 4. Vincula o arquivo à nota fixa "📎 Arquivos" (achável; antes era a nota mais recente)
  let noteId = null;
  if (userId) {
    try {
      noteId = await getOrCreateArquivosNote(userId);
      console.log('LINK NOTE ID (Arquivos):', noteId);
    } catch (e) {
      console.error('CREATE/FETCH ARQUIVOS NOTE ERR:', e.message);
    }
  }

  // Salva metadados na tabela files (id gerado pelo banco — uuid default)
  const filename = timestamp + '.' + ext;
  const metaRes = await fetch(SUPABASE_URL + '/rest/v1/files', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      note_id:    noteId,
      user_id:    userId || null,
      name:       filename,
      size:       fileBuffer.byteLength,
      mime_type:  mediaType,
      path:       path,
      url:        path,
      created_at: new Date().toISOString(),
    }),
  });
  if (!metaRes.ok) {
    const metaErr = await metaRes.text();
    console.error('FILE META INSERT FAILED:', metaRes.status, metaErr);
    throw new Error('Falha ao registrar o arquivo: ' + metaRes.status);
  }
  console.log('FILE META OK:', metaRes.status, path);

  // 5. Retorna a URL assinada
  return signedUrl;
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function askClaude(system, messages, model) {
  const resolvedModel = model || 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      resolvedModel,
      max_tokens: 1500,
      system:     system,
      messages:   messages,
    }),
  });
  console.log('CLAUDE STATUS:', res.status, '| MODEL:', resolvedModel);
  const data = await res.json();
  if (data.content && data.content[0] && data.content[0].text) return data.content[0].text;
  if (data.error) console.error('CLAUDE ERROR:', JSON.stringify(data.error));
  return null;
}


// ─── Vision (imagem→agenda/nota) — helpers ──────────────────────────────────

// Tool que PROPÕE um evento a partir da imagem (não cria; criação só após "sim").
const PROPOR_EVENTO_TOOL = {
  name: 'propor_evento',
  description: 'Use quando o usuário enviar uma IMAGEM e pedir para criar evento/agenda/compromisso a partir dela. Extrai os dados e PROPÕE — NUNCA cria direto. A criação ocorre só após confirmação explícita do usuário.',
  input_schema: {
    type: 'object',
    properties: {
      title:    { type: 'string', description: 'Título curto do evento lido na imagem.' },
      datetime: { type: 'string', description: 'Início em ISO com fuso de Brasília, ex: "2026-06-29T19:30:00-03:00". Use a tabela de datas do sistema para resolver datas/dias relativos.' },
      local:    { type: 'string', description: 'Opcional. Local/endereço do evento, se aparecer na imagem.' },
      confianca:{ type: 'string', enum: ['alta', 'baixa'], description: 'baixa se a imagem estiver ilegível ou a data/hora estiver incerta.' },
    },
    required: ['title', 'datetime'],
  },
};

// Detecta se a legenda da imagem pede para LER o conteúdo (Vision) — agenda ou nota-conteúdo.
// Sem legenda → false (storage puro). Regex léxico (mesma família do G-28): ajustável.
function _temIntencaoVision(texto) {
  const t = (texto || '').toLowerCase().trim();
  if (!t) return false;
  const agenda = /(agend|evento|compromisso|reuni[ãa]o|marcar?\b|p[õo]e.*(agenda|calend)|adicion.*(agenda|calend))/.test(t);
  const notaConteudo = /(informa[çc]|conte[úu]do|dados|extra[ií]|transcrev|resum|\bler\b|\bleia\b|\bl[êe]\b|o que (tem|diz|est[áa]))/.test(t);
  return agenda || notaConteudo;
}

// Formata um ISO em "DD/MM às HH:MM" no fuso de Brasília (mensagem de confirmação).
function _fmtDataHoraBR(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: USER_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).replace(',', ' às');
  } catch (e) { return iso; }
}

// Baixa a mídia do Twilio (auth Basic) uma única vez e devolve buffer + base64.
async function fetchTwilioMediaBase64(mediaUrl) {
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const r = await fetch(mediaUrl, { headers: { 'Authorization': 'Basic ' + auth } });
  if (!r.ok) throw new Error('Erro ao baixar mídia do Twilio: ' + r.status);
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, base64: buffer.toString('base64') };
}

// Lê a proposta pendente não-expirada do usuário (ou null).
async function getVisionPending(userId) {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/vision_pending?user_id=eq.' + encodeURIComponent(userId) +
      '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) +
      '&select=kind,payload,confidence&limit=1',
    { headers: googleSbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// Grava/atualiza a proposta pendente (1 por usuário; sobrescreve). TTL em minutos (default 15).
async function setVisionPending(userId, kind, payload, confidence, ttlMinutes) {
  const expiresAt = new Date(Date.now() + (ttlMinutes || 15) * 60000).toISOString();
  await fetch(
    SUPABASE_URL + '/rest/v1/vision_pending?on_conflict=user_id',
    {
      method: 'POST',
      headers: { ...googleSbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id:    userId,
        kind:       kind,
        payload:    payload,
        confidence: confidence || null,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
      }),
    }
  );
}

// Apaga a proposta pendente do usuário.
async function clearVisionPending(userId) {
  await fetch(
    SUPABASE_URL + '/rest/v1/vision_pending?user_id=eq.' + encodeURIComponent(userId),
    { method: 'DELETE', headers: googleSbHeaders() }
  );
}

// Acha (ou cria) a nota fixa "📎 Arquivos" do usuário — lar achável dos arquivos soltos.
async function getOrCreateArquivosNote(userId) {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/notes?user_id=eq.' + encodeURIComponent(userId) +
        '&title=eq.' + encodeURIComponent('📎 Arquivos') + '&limit=1&select=id',
      { headers: googleSbHeaders() }
    );
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) return rows[0].id;
  } catch (e) { console.error('getOrCreateArquivosNote find err:', e.message); }
  return await createNote({
    title: '📎 Arquivos',
    content: 'Arquivos enviados pelo WhatsApp ficam anexados aqui.',
    cluster: 'inbox',
    tags: ['arquivos'],
    user_id: userId,
  });
}

// Sobe a mídia ao Storage e cria a linha em `files` vinculada a UMA nota específica
// (noteId explícito — corrige o "anexa à nota mais recente" do uploadMediaToStorage).
async function persistMediaToNote({ buffer, mediaType, phone, userId, noteId }) {
  const ext       = mimeToExt(mediaType);
  const timestamp = Date.now();
  const folder    = userId || ('phone-' + phone.replace(/\D/g, ''));
  const path      = folder + '/whatsapp/' + timestamp + '.' + ext;

  const storageUrl = SUPABASE_URL + '/storage/v1/object/mentai-files/' + path;
  const upRes = await fetch(storageUrl, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type':  mediaType,
      'x-upsert':      'true',
    },
    body: buffer,
  });
  if (!upRes.ok) {
    const upErr = await upRes.text();
    throw new Error('Erro no upload Storage: ' + upRes.status + ' ' + upErr);
  }

  const filename = timestamp + '.' + ext;
  const fRes = await fetch(SUPABASE_URL + '/rest/v1/files', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      note_id:    noteId,
      user_id:    userId || null,
      name:       filename,
      size:       buffer.byteLength,
      mime_type:  mediaType,
      path:       path,
      url:        path,
      created_at: new Date().toISOString(),
    }),
  });
  if (!fRes.ok) {
    const fErr = await fRes.text();
    console.error('PERSIST FILE INSERT FAILED:', fRes.status, fErr);
    return false;
  }
  return true;
}

// ─── Handler Principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // ── Validação de assinatura Twilio (manual, sem dependência externa) ──────
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN || '';
    const signature = req.headers['x-twilio-signature'] || '';
    const params    = req.body || {};
    const candidateUrls = [
      'https://pallyum.com/api/whatsapp',
      'https://www.pallyum.com/api/whatsapp',
    ];
    let isValid = false, matchedUrl = null;
    for (const url of candidateUrls) {
      if (validateTwilioSignature(authToken, signature, url, params)) {
        isValid = true; matchedUrl = url; break;
      }
    }
    const enforce = process.env.TWILIO_ENFORCE_SIGNATURE === 'true';
    console.log('TWILIO SIG CHECK | valid:', isValid, '| matchedUrl:', matchedUrl || 'none', '| enforce:', enforce);
    if (!isValid && enforce) {
      return res.status(403).json({ error: 'Invalid Twilio signature' });
    }
  } catch (e) {
    console.log('TWILIO SIG CHECK ERROR:', e.message);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const body      = req.body || {};
  const phone     = normalizePhone((body.From || '').replace('whatsapp:', ''));
  const mediaUrl  = body.MediaUrl0 || '';
  const mediaType = (body.MediaContentType0 || '').toLowerCase();
  const hasAudio  = mediaType.startsWith('audio/') && mediaUrl;
  const hasMedia  = !hasAudio && mediaUrl && mediaType; // imagem ou documento

  let userMessage  = (body.Body || '').trim();
  let savedFileUrl = null; // URL assinada do arquivo salvo (se houver)
  console.log('FROM:', phone, '| MSG:', userMessage.substring(0, 80), '| MEDIA:', mediaType || 'none');

  // Registra o último inbound (a janela de 24h do WhatsApp abre/renova a cada msg do usuário)
  await touchLastInbound(phone);

  // Toque no botão do template do briefing → entrega o briefing completo do cache e encerra
  if (body.ButtonPayload === 'VER_BRIEFING') {
    console.log('BRIEFING TAP | ButtonPayload:', body.ButtonPayload, '| ButtonText:', body.ButtonText || 'none', '| Body:', body.Body || 'none');
    const uid = await getUserIdByPhone(phone);
    if (uid) {
      const cached = await getBriefingCache(uid);
      await sendWhatsApp(
        phone,
        cached || 'Seu briefing ainda não está pronto. Você o recebe no horário configurado nas Configurações do Pallyum.'
      );
    }
    return res.status(200).send('OK');
  }

  // ── Transcrição de áudio ──────────────────────────────────────────────────
  if (hasAudio) {
    try {
      const transcription = await transcribeAudio(mediaUrl, mediaType);
      if (transcription) {
        userMessage = transcription;
        console.log('TRANSCRIPTION:', userMessage);
      } else {
        await sendWhatsApp(phone, 'Não consegui transcrever o áudio. Tente enviar uma mensagem de texto.');
        return res.status(200).send('OK');
      }
    } catch (err) {
      console.error('TRANSCRIBE ERR:', err.message);
      await sendWhatsApp(phone, 'Erro ao processar áudio: ' + err.message);
      return res.status(200).send('OK');
    }
  }

  if (!userMessage && !hasMedia) {
    await sendWhatsApp(phone, 'Envie uma mensagem de texto, áudio, imagem ou documento.');
    return res.status(200).send('OK');
  }

  // ── Detecta intenções ─────────────────────────────────────────────────────
  const needsCalendar = /agenda|calend|evento|reuni|hoje|amanh|semana|hor[áa]rio|compromisso|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|livre|ocupad|marcad|dispon[íi]vel/i.test(userMessage);
  const needsGmail    = /e-?mails?|gmail|caixa|inbox|correio/i.test(userMessage);
  const needsGoogle   = needsCalendar || needsGmail;

  // ── Google: tokens + dados ────────────────────────────────────────────────
  let accessToken    = null;
  let calendarEvents = [];
  let gmailMessages  = [];
  let googleConnected = false;
  let userId         = null;
  let accounts       = [];
  let nylasWrite     = []; // grants Nylas p/ ESCRITA de evento — function-level (usada no try#2: system prompt + handler)

  try {
    const resolvedUserId = await getUserIdByPhone(phone);
    userId = resolvedUserId;
    console.log('USER ID:', userId);

    // ── Código de ativação/reativação — verifica SEMPRE, independente de userId ──
    // Permite trocar número mesmo quando já vinculado: sobrescreve o vínculo anterior.
    const msgTrimmed = userMessage.trim();
    if (/^\d{6}$/.test(msgTrimmed)) {
      try {
        const pendingResp = await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_pending?code=eq.${encodeURIComponent(msgTrimmed)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=user_id`,
          { headers: googleSbHeaders() }
        );
        if (pendingResp.ok) {
          const pendingRows = await pendingResp.json();
          if (pendingRows.length > 0) {
            const activationUserId = pendingRows[0].user_id;
            // Upsert com o número REAL do Twilio (já normalizado) — sobrescreve vínculo anterior
            await fetch(
              `${SUPABASE_URL}/rest/v1/phone_users`,
              {
                method:  'POST',
                headers: { ...googleSbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
                body:    JSON.stringify({ phone, user_id: activationUserId }),
              }
            );
            await fetch(
              `${SUPABASE_URL}/rest/v1/whatsapp_pending?code=eq.${encodeURIComponent(msgTrimmed)}`,
              { method: 'DELETE', headers: googleSbHeaders() }
            );
            console.log('[whatsapp] ATIVAÇÃO OK | phone=' + phone + ' | userId=' + activationUserId);
            await sendWhatsApp(phone, '✅ WhatsApp vinculado a esta conta.');
            return res.status(200).send('OK');
          }
        }
      } catch (e) {
        console.error('[whatsapp] erro ao processar ativação:', e.message);
      }
    }

    // ── Número desconhecido sem código válido → instrução de ativação ─────────
    if (!userId) {
      await sendWhatsApp(phone, 'Olá! Para ativar o WhatsApp no Pallyum, abra o app → aba WhatsApp e siga as instruções. 📱');
      return res.status(200).send('OK');
    }

    // Gate de plano ativo (Etapa 04): plano vencido → modo leitura no WhatsApp.
    // Ativação e número desconhecido já retornaram acima; aqui userId é válido.
    // Resposta em texto livre (a janela de 24h acabou de abrir com este inbound).
    if (!(await isPlanActive(userId))) {
      await sendWhatsApp(phone, 'Seu plano está inativo no momento. Suas notas e agenda continuam guardadas — escolha um plano em https://pallyum.com/app?view=planos e o Jarvis volta na hora. 🙂');
      return res.status(200).send('OK');
    }

    // ── Modelo e cooldown por plano ───────────────────────────────────────
    if (userId) {
      const [userModel, cooldown] = await Promise.all([
        getModelForUser(userId),
        calculateCooldown(userId),
      ]);
      req._pallyumModel    = userModel;
      req._pallyumCooldown = cooldown;
      console.log('PLAN: model=' + userModel + ' | cooldown=' + cooldown);

      if (cooldown === 'BLOCKED') {
        await sendWhatsApp(phone, 'Limite de uso atingido. Entre em contato com o suporte pelo app.');
        return res.status(200).send('OK');
      }
      // Aplica delay fair-use ANTES de processar (parece "digitando...")
      if (cooldown > 0) await sleep(cooldown);
    }

    // ── Confirmação de proposta Vision pendente (turn "sim"/"não", só texto) ──
    if (!hasMedia) {
      const _pend = await getVisionPending(userId);
      if (_pend && _pend.kind === 'evento') {
        const _tC = (userMessage || '').toLowerCase().trim();
        const _afirma = _tC === '👍' || _tC === '✅' ||
          /^(sim|s|isso|ok|okay|claro|confirmo|confirmar|pode|pode criar|cria|criar|manda|bora|positivo)\b/.test(_tC);
        const _nega = /^(n[ãa]o|nao|n|cancela|cancelar|deixa|esquece|para|negativo)\b/.test(_tC);
        if (_afirma) {
          const _pl = _pend.payload || {};
          let _tkC = null;
          try {
            const _accC = await getAllGoogleAccounts(userId, phone);
            const _ord = (_accC || []).slice().sort(function (a, b) { return (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0); });
            for (const _acc of _ord) { try { _tkC = await ensureAccountToken(_acc); break; } catch (e) { console.error('CONFIRM TOKEN FAIL:', e.message); } }
          } catch (e) { console.error('CONFIRM ACCOUNTS ERR:', e.message); }
          if (!_tkC) {
            await clearVisionPending(userId);
            await sendWhatsApp(phone, '⚠️ Conecte sua agenda Google no app e envie a imagem novamente.');
            return res.status(200).send('OK');
          }
          const _descC = _pl.local ? ('Local: ' + _pl.local) : '';
          let _confC = '';
          try {
            const _r = await createCalendarEvent(_tkC, _pl.title, _pl.datetime_iso, _descC);
            _confC = (_r && _r.id) ? ('✅ "' + _pl.title + '" criado na sua agenda.') : ('⚠️ Não consegui criar "' + _pl.title + '".');
          } catch (e) { console.error('CONFIRM CREATE ERR:', e.message); _confC = '⚠️ Erro ao criar o evento.'; }
          await clearVisionPending(userId);
          await saveMessage(phone, 'user', userMessage);
          await saveMessage(phone, 'assistant', _confC);
          await sendWhatsApp(phone, _confC);
          return res.status(200).send('OK');
        } else if (_nega) {
          await clearVisionPending(userId);
          const _negMsg = 'Ok, não criei nada. 👍';
          await saveMessage(phone, 'user', userMessage);
          await saveMessage(phone, 'assistant', _negMsg);
          await sendWhatsApp(phone, _negMsg);
          return res.status(200).send('OK');
        }
        // Nem sim nem não → mantém a proposta (TTL cuida) e segue o fluxo normal.
      }
    }

    // ── Mídia recebida: rota Vision (imagem + intenção) OU storage puro ───
    if (hasMedia) {
      const isImage = mediaType.startsWith('image/');
      const visionIntent = isImage && _temIntencaoVision(userMessage);

      if (visionIntent) {
        try {
          // 1) Gate de cota ANTES de qualquer inferência
          const vq = await checkVisionQuota(userId);
          if (!vq.allowed) {
            const msgLimite = (vq.quota === 0)
              ? 'A leitura de imagens (Vision) está disponível nos planos Pro e Ultra. Faça upgrade no app para usar. 📷'
              : 'Você atingiu o limite de ' + vq.quota + ' imagens deste mês. O limite renova no início do próximo mês. 📷';
            await sendWhatsApp(phone, msgLimite);
            return res.status(200).send('OK');
          }

          // 2) Baixa a imagem uma vez (base64 pro modelo)
          const visionImg = await fetchTwilioMediaBase64(mediaUrl);

          // 3) System prompt focado em extração da imagem
          const vAssistant = await getAssistantName(userId);
          const vAgora = new Intl.DateTimeFormat('pt-BR', {
            timeZone: USER_TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(new Date());
          let vSystem = 'Você é o ' + vAssistant + ', assistente via WhatsApp. O usuário enviou uma IMAGEM com uma instrução. Leia a imagem e aja conforme a instrução. Responda em português, curto.\n\n';
          vSystem += 'Data e hora atuais: ' + vAgora + '. Use para resolver datas e dias relativos.\n';
          let vRef = 'Tabela de datas (use SEMPRE para converter dias da semana; nunca calcule de cabeça):\n';
          const vBase = Date.now();
          for (let i = 0; i <= 14; i++) {
            const vd = new Date(vBase + i * 86400000);
            const vds = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, weekday: 'long' }).format(vd);
            const vdf = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(vd);
            vRef += '- ' + (i === 0 ? vds + ' (hoje)' : vds) + ': ' + vdf + '\n';
          }
          vSystem += vRef + '\n';
          vSystem += 'REGRAS:\n';
          vSystem += '- Se a instrução for criar evento/agenda/compromisso a partir da imagem: use a ferramenta propor_evento (title curto; datetime em ISO com fuso de Brasília; local se aparecer). NUNCA crie o evento direto — propor_evento apenas PROPÕE; a criação ocorre após o usuário confirmar.\n';
          vSystem += '- Se a instrução for criar uma nota com o conteúdo/informações da imagem: use criar_nota (title curto; content = as informações lidas na imagem, organizadas e legíveis; cluster apropriado).\n';
          vSystem += '- Se a imagem estiver ilegível, ou faltar data/hora para um evento, NÃO invente: responda em texto pedindo uma foto mais nítida.\n';

          // 4) Mensagem com content block de imagem (sem histórico)
          const vUserText = userMessage || 'Aja conforme a imagem.';
          const vMsgs = [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: visionImg.base64 } },
              { type: 'text', text: vUserText },
            ],
          }];

          // 5) Chamada — só criar_nota + propor_evento; tool_choice AUTO (permite "não consegui ler")
          const vTools = NOTE_TOOLS.filter(function (t) { return t.name === 'criar_nota'; }).concat([PROPOR_EVENTO_TOOL]);
          const vModel = routeModel(req._pallyumModel, { isAction: true });
          const vContent = await askClaudeTools(vSystem, vMsgs, vModel, vTools, undefined);

          if (!vContent) {
            await sendWhatsApp(phone, 'Não consegui processar a imagem agora. Tente novamente em instantes.');
            return res.status(200).send('OK');
          }

          // 6) Inferência ocorreu → conta +1 (independe do caminho: nota ou agenda)
          const vNovoTotal = await incrementVisionUsage(userId);
          console.log('[VISION] model=' + vModel + ' | uso=' + vNovoTotal + '/' + vq.quota);

          const vText = (vContent || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
          const vToolUses = (vContent || []).filter(function (b) { return b && b.type === 'tool_use'; });
          console.log('[VISION] tools=' + vToolUses.map(function (t) { return t.name; }).join(',') + ' | text=' + (vText || '').substring(0, 80));

          // 7) Executa o resultado
          let vReply = '';
          if (vToolUses.length === 0) {
            vReply = vText || 'Não consegui ler a imagem. Pode enviar uma foto mais nítida?';
          } else {
            for (const tu of vToolUses) {
              const inp = tu.input || {};
              try {
                if (tu.name === 'criar_nota') {
                  inp.user_id = userId;
                  const noteId = await createNote(inp);
                  if (noteId) {
                    let _anexoOk = false;
                    try {
                      _anexoOk = await persistMediaToNote({ buffer: visionImg.buffer, mediaType: mediaType, phone: phone, userId: userId, noteId: noteId });
                    } catch (pe) { console.error('VISION PERSIST ERR:', pe.message); }
                    vReply += _anexoOk
                      ? ('📝 Nota "' + (inp.title || '') + '" criada com o conteúdo da imagem (arquivo anexado).')
                      : ('📝 Nota "' + (inp.title || '') + '" criada com o conteúdo da imagem.');
                  } else {
                    vReply += '⚠️ Não consegui criar a nota.';
                  }
                } else if (tu.name === 'propor_evento') {
                  const vPayload = { title: inp.title, datetime_iso: inp.datetime, local: inp.local || null, account: null };
                  await setVisionPending(userId, 'evento', vPayload, inp.confianca || null, 15);
                  const vDataFmt = _fmtDataHoraBR(inp.datetime);
                  const vLocal = inp.local ? (' — ' + inp.local) : '';
                  const vAviso = (inp.confianca === 'baixa') ? '\n_(Não tenho certeza da leitura; confira a data/hora.)_' : '';
                  vReply += 'Vou criar: *' + inp.title + '*, ' + vDataFmt + vLocal + ' — confirma? (responda *sim*)' + vAviso;
                }
              } catch (te) { console.error('VISION TOOL ERR:', tu.name, te.message); vReply += '⚠️ Erro ao processar a ação.'; }
            }
          }

          vReply = (vReply || '✅ Feito!').trim();
          await saveMessage(phone, 'user', userMessage || '[imagem]');
          await saveMessage(phone, 'assistant', vReply);
          await sendWhatsApp(phone, vReply);
          if (userId) trackUsage(userId, 'whatsapp', { audio: false, image: true }).catch(console.error);
          return res.status(200).send('OK');
        } catch (ve) {
          console.error('VISION FATAL:', ve.message);
          await sendWhatsApp(phone, 'Tive um problema ao processar a imagem. Tente novamente.');
          return res.status(200).send('OK');
        }
      }

      // ── Storage puro (comportamento atual, inalterado) ──
      try {
        savedFileUrl = await uploadMediaToStorage(mediaUrl, mediaType, phone, userId);
        console.log('MEDIA SAVED:', savedFileUrl ? 'OK' : 'sem URL assinada');
        if (!userMessage) {
          userMessage = isImage
            ? '[O usuário enviou uma imagem que foi salva no vault.]'
            : '[O usuário enviou um documento (' + mediaType + ') que foi salvo no vault.]';
        }
      } catch (err) {
        console.error('UPLOAD MEDIA ERR:', err.message);
        userMessage = userMessage || '[O usuário enviou um arquivo, mas não foi possível salvá-lo: ' + err.message + ']';
      }
    }

    accounts = await getAllGoogleAccounts(userId, phone);

    // Grants Nylas no escopo do HANDLER de tools (busca dedicada p/ ESCRITA de evento).
    // Separada do bloco de leitura agregada — não reusa a var interna nylasGrants de lá.
    // Identidade: userId pode ser null no WhatsApp (id por phone). MESMA derivação 3-tier
    // do bloco de leitura: userId → phone_users → user_id das contas Google já carregadas.
    let nylasWriteUid = userId;
    if (!nylasWriteUid) {
      try { nylasWriteUid = await getUserIdByPhone(phone); }
      catch (e) { console.error('NYLAS userId via phone_users ERR:', e.message); }
    }
    if (!nylasWriteUid) {
      const _accComUid = accounts.find(function (a) { return a && a.user_id; });
      nylasWriteUid = _accComUid ? _accComUid.user_id : null;
    }
    // nylasWrite é function-level (declarada junto de accounts). Aqui só populamos.
    if (nylasWriteUid) {
      try { nylasWrite = await getAllNylasGrants(nylasWriteUid); } catch (e) { nylasWrite = []; }
    }

    if (accounts.length > 0) {
      googleConnected = true;
      // Tenta a principal primeiro; se o refresh dela falhar, cai pra próxima conta saudável.
      const ordered = accounts.slice().sort(function(a, b) { return (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0); });
      for (const acc of ordered) {
        try { accessToken = await ensureAccountToken(acc); break; }
        catch (e) { console.error('TOKEN FAIL (' + acc.email + '):', e.message); }
      }
      if (needsCalendar) {
        for (const acc of accounts) {
          try {
            const tk  = await ensureAccountToken(acc);
            const evs = await getCalendarEvents(tk);
            evs.forEach(function(e){ e._accountEmail = acc.email; });
            calendarEvents = calendarEvents.concat(evs);
          } catch (e) { console.error('CAL ACCOUNT ERR (' + acc.email + '):', e.message); }
        }
        // Une grants Nylas (Outlook/iCloud/IMAP…) — read-only, já vem no shape Google.
        // nylas_grants é chaveada por user_id (sem coluna phone). No WhatsApp o `userId`
        // vem de getUserIdByPhone(phone) e pode ser null se o número não estiver em
        // phone_users — mas as contas Google já carregadas (google_tokens filtradas por
        // phone) trazem o user_id real. Resolve em camadas; pula só se NÃO houver id.
        let nylasUserId = userId;
        if (!nylasUserId) {
          try { nylasUserId = await getUserIdByPhone(phone); }
          catch (e) { console.error('NYLAS userId via phone_users ERR:', e.message); }
        }
        if (!nylasUserId) {
          const _accComUid = accounts.find(function (a) { return a && a.user_id; });
          nylasUserId = _accComUid ? _accComUid.user_id : null;
        }
        let nylasGrants = [];
        if (nylasUserId) {
          try {
            nylasGrants = await getAllNylasGrants(nylasUserId);
            for (const g of nylasGrants) {
              try {
                const evs = await getCalendarEventsNylas(g);
                evs.forEach(function(e){ e._accountEmail = g.email; });
                calendarEvents = calendarEvents.concat(evs);
              } catch (e) { console.error('NYLAS CAL ACCOUNT ERR (' + g.email + '):', e.message); }
            }
          } catch (e) { console.error('NYLAS GRANTS ERR:', e.message); }
        }
        calendarEvents.sort(function(a,b){
          return new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date);
        });
        console.log('CALENDAR EVENTS (agregado):', calendarEvents.length, '| contas:', accounts.length);
        console.log('CALENDAR EVENTS (com Nylas):', calendarEvents.length, '| nylas grants:', nylasGrants?.length || 0);
      }
      if (needsGmail) {
        gmailMessages = await getGmailMessages(accessToken);
        console.log('GMAIL MESSAGES:', gmailMessages.length);
      }
    } else if (needsGoogle) {
      const token = signState({ phone, exp: Date.now() + 24 * 60 * 60 * 1000 });
      const authLink = 'https://pallyum.com/api/auth/google?token=' + encodeURIComponent(token);
      await sendWhatsApp(phone, 'Para acessar sua agenda e emails, conecte o Google primeiro: ' + authLink);
      return res.status(200).send('OK');
    }
  } catch (err) {
    console.error('GOOGLE ERR:', err.message);
  }

  // ── Histórico + Notas ─────────────────────────────────────────────────────
  try {

    // ── Detecta e processa transcrição de reunião ─────────────────────────
    if (detectMeetingTranscript(userMessage)) {
      console.log('TRANSCRIPT DETECTED: processando como reunião');
      try {
        const meetData = await processMeetingTranscript(userMessage, userId, req._pallyumModel);
        const parts = (meetData.participants || []).join(', ') || '—';
        const nDec  = (meetData.decisions || []).length;
        const nAct  = (meetData.actions   || []).length;
        const confirmMsg = [
          '✅ *Reunião registrada no vault!*',
          '',
          '📌 *' + (meetData.title || 'Reunião') + '*',
          '👥 Participantes: ' + parts,
          '✔️ ' + nDec + ' decisão(ões) registrada(s)',
          '📋 ' + nAct + ' próxima(s) ação(ões)',
          '',
          '📝 ' + (meetData.summary || '').substring(0, 250),
        ].join('\n');
        await saveMessage(phone, 'user', '[transcrição de reunião — ' + userMessage.length + ' chars]');
        await saveMessage(phone, 'assistant', confirmMsg);
        await sendWhatsApp(phone, confirmMsg);
        return res.status(200).send('OK');
      } catch (transcriptErr) {
        console.error('TRANSCRIPT ERR:', transcriptErr.message, '— continuando fluxo normal');
        // Se a extração falhar, continua para o fluxo normal do Claude
      }
    }

    const history = await getHistory(phone);

    // ── RAG semântico: busca notas relevantes para a mensagem ─────────────
    let ragContext = '';
    if (userId) {
      try {
        const ragNotes = await searchRelevantNotes(userId, userMessage);
        ragContext = buildRagContext(ragNotes);
        console.log('RAG:', ragNotes.length, 'notas encontradas para:', userMessage.substring(0, 60));
      } catch (ragErr) {
        console.warn('RAG error (non-fatal):', ragErr.message);
      }
    }

    const agoraTZ = new Intl.DateTimeFormat('pt-BR', {
      timeZone: USER_TZ,
      weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

    // ── System Prompt ─────────────────────────────────────────────────────
    const assistantName = await getAssistantName(userId);
    let system = 'Você é o ' + assistantName + ', assistente pessoal via WhatsApp. Responda em português, de forma curta e direta.\n\n';
    system += 'Data e hora atuais: ' + agoraTZ + '. Use isto para resolver "hoje", "amanhã", dias da semana e datas relativas.\n\n';

    let refDatas = 'Tabela de datas (use SEMPRE para converter dias da semana; NUNCA calcule de cabeça):\n';
    const baseMs = Date.now();
    for (let i = 0; i <= 7; i++) {
      const d = new Date(baseMs + i * 86400000);
      const diaSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, weekday: 'long' }).format(d);
      const dataFmt   = new Intl.DateTimeFormat('pt-BR', { timeZone: USER_TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
      refDatas += '- ' + (i === 0 ? diaSemana + ' (hoje)' : diaSemana) + ': ' + dataFmt + '\n';
    }
    system += refDatas + '\n';

    if (savedFileUrl) {
      system += 'ARQUIVO RECEBIDO: O usuário enviou um arquivo via WhatsApp que foi salvo no vault, na nota "📎 Arquivos". Mencione de forma curta que o arquivo foi recebido e salvo lá.\n\n';
    }

    if (ragContext) {
      system += ragContext + '\n\n';
    }

    if (googleConnected) {
      system += 'AGENDA (próximos dias, horário de Brasília):\n' + formatCalendarEvents(calendarEvents) + '\n\n';
      if (gmailMessages.length > 0) {
        system += 'EMAILS NÃO LIDOS:\n' + formatGmailMessages(gmailMessages) + '\n\n';
      }
    }

    system += 'AÇÕES — use as FERRAMENTAS para agir quando o usuário pedir uma ação (não descreva a ação só em texto). Notas: criar_nota (registrar informação, ideia ou ata de reunião que já aconteceu), atualizar_nota (acrescentar a uma nota existente, pelo título exato), apagar_nota.\n';
    const temAgenda = (accounts.length > 0) || (nylasWrite.length > 0);
    if (temAgenda) {
      const listaGoogle = accounts.map(a => a.email + (a.is_primary ? ' (principal)' : ''));
      const listaNylas  = nylasWrite.map(g => g.email + (g.provider ? ' (' + g.provider + ')' : '') + (g.is_primary ? ' (principal)' : ''));
      const listaContas = listaGoogle.concat(listaNylas).join(', ');
      system += 'CONTAS DE AGENDA CONECTADAS (para eventos): ' + listaContas + '.\n';
      system += 'Agenda: use criar_evento, atualizar_evento, apagar_evento para marcar, remarcar ou cancelar compromissos/reuniões com data ou hora.\n';
      system += 'Para criar, editar ou apagar um evento numa conta específica, passe o email dela no parâmetro `account` — vale para qualquer conta listada acima, Google ou não.\n';
    }
    system += 'Distinção: marcar/agendar algo com data ou hora é sempre AGENDA (criar_evento), nunca nota; registrar informação/ideia/ata é NOTA (criar_nota); no conteúdo da nota coloque só a informação, nunca a frase de comando. Para perguntas e conversa, responda em texto sem acionar ferramenta. Confirme cada ação de forma curta e nunca diga que não consegue fazê-las.\n';
    system += '- Quando o usuário mencionar dias da semana (sexta, sábado, segunda, etc), sempre converta para a data completa DD/MM/YYYY baseado na data atual.\n';

    // ── Chamada ao Claude ─────────────────────────────────────────────────
    const msgs = history
      .map(function(m) { return { role: m.role, content: m.content }; })
      .concat([{ role: 'user', content: userMessage }]);

    const _tools = temAgenda ? NOTE_TOOLS.concat(EVENT_TOOLS) : NOTE_TOOLS;
    const _ehAcao = /\b(marc|agend|cri[ae]|cancel|remarc|desmarc|reagend|adia|anot|registr|salv|apag|delet|adicion|exclu|altera|edita|mud[ae])/i.test(userMessage || '');
    // _ehAcao segue alimentando o routeModel (Haiku p/ ação). tool_choice agora é auto:
    // o modelo decide se chama ferramenta (a linha de Distinção orienta), em vez de forçar
    // { type:'any' } — que fazia perguntas ("qual minha agenda?") virarem criar_evento.
    const _routedModel = routeModel(req._pallyumModel, { isAction: _ehAcao });
    console.log('[G-28] modelo roteado:', _routedModel, '| isAction:', _ehAcao, '| teto:', req._pallyumModel);
    const _content = await askClaudeTools(system, msgs, _routedModel, _tools, undefined);
    const reply = (_content || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    const _toolUses = (_content || []).filter(function (b) { return b && b.type === 'tool_use'; });
    console.log('REPLY:', (reply || '').substring(0, 200), '| TOOL_USES:', _toolUses.map(function (t) { return t.name; }).join(','));

    if (!reply && (!_toolUses || _toolUses.length === 0)) {
      await sendWhatsApp(phone, 'Não consegui processar. Tente novamente.');
      return res.status(200).send('OK');
    }

    // ── Executa ações a partir das tags ──────────────────────────────────
    let finalReply = stripActionTags(reply);

    function parseRobust(tag, rawReply) {
      const m = rawReply.match(new RegExp('\\[' + tag + ':([\\s\\S]*?)\\](?=\\s|$)'));
      if (!m) return null;
      try {
        const cleaned = m[1]
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          .trim();
        return JSON.parse(cleaned);
      } catch (e) {
        try {
          const titleMatch = m[1].match(/"title"\s*:\s*"([^"]+)"/);
          if (titleMatch) {
            return { title: titleMatch[1], content: null };
          }
        } catch (e2) {}
        console.error('PARSE TAG ERR (' + tag + '):', e.message, 'RAW:', m[1].substring(0, 100));
        return null;
      }
    }

    // ── Helper: resolve token da conta-alvo ou da principal; fallback sequencial ─
    // Se a conta-alvo falhar no refresh, tenta as demais em ordem (principal primeiro).
    // Retorna null se nenhuma conta tiver token renovável — o loop de actions
    // detecta null e usa a mensagem de "conexão expirou".
    // Token Google de uma conta + fallback sequencial principal-primeiro (como antes).
    const _tokenGoogleSequencial = async (contaAlvo) => {
      const candidatos = [contaAlvo, ...accounts.filter(a => a !== contaAlvo)]
        .sort(function(a, b) { return (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0); });
      const ordenados = [contaAlvo, ...candidatos.filter(a => a !== contaAlvo)];
      for (const acc of ordenados) {
        try { return await ensureAccountToken(acc); }
        catch (e) { console.error('resolverContaToken FAIL (' + acc.email + '):', e.message); }
      }
      return null; // todas falharam
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

    // ── Executa ações via tool use (notas + agenda) ───────────────────────
    let actionConfirm = '';
    for (const tu of _toolUses) {
      const inp = tu.input || {};
      try {
        if (tu.name === 'criar_nota') {
          inp.user_id = userId;
          const id = await createNote(inp);
          actionConfirm += id ? ('📝 Nota "' + (inp.title || '') + '" criada.\n') : ('⚠️ Não consegui criar a nota.\n');
        } else if (tu.name === 'atualizar_nota') {
          const ok = await updateNote(inp.title, inp.content || userMessage, userId);
          actionConfirm += ok ? ('📝 Nota "' + inp.title + '" atualizada.\n') : ('⚠️ Não encontrei a nota "' + inp.title + '".\n');
        } else if (tu.name === 'apagar_nota') {
          const okDel = await deleteNote(inp.title);
          actionConfirm += okDel ? ('🗑️ Nota "' + inp.title + '" movida para a lixeira.\n') : ('⚠️ Não encontrei a nota "' + inp.title + '".\n');
        } else if (tu.name === 'criar_evento' || tu.name === 'atualizar_evento' || tu.name === 'apagar_evento') {
          // Aborta SÓ se não houver conta alguma (Google nem Nylas).
          if (accounts.length === 0 && nylasWrite.length === 0) {
            actionConfirm += '⚠️ Conecte uma agenda no app → Configurações → Conexões externas.\n';
            continue;
          }
          const alvo = await resolverContaAlvo(inp.account);
          if (!alvo) {
            actionConfirm += '⚠️ Não consegui acessar sua agenda. Reconecte no app em Configurações → Conexões externas.\n';
            continue;
          }
          if (tu.name === 'criar_evento') {
            const r = (alvo.tipo === 'nylas')
              ? await createCalendarEventNylas(alvo.grant, inp.title, inp.datetime, inp.description || '')
              : await createCalendarEvent(alvo.token, inp.title, inp.datetime, inp.description || '');
            actionConfirm += (r && r.id) ? ('✅ "' + inp.title + '" agendado.\n') : ('⚠️ Não consegui criar "' + inp.title + '".\n');
          } else if (tu.name === 'atualizar_evento') {
            const ok = (alvo.tipo === 'nylas')
              ? !!(await updateCalendarEventNylas(alvo.grant, inp.title, inp.new_datetime))
              : await updateCalendarEvent(alvo.token, inp.title, inp.new_datetime);
            actionConfirm += ok ? ('✅ "' + inp.title + '" remarcado.\n') : ('⚠️ Não encontrei "' + inp.title + '" para remarcar.\n');
          } else {
            const ok = (alvo.tipo === 'nylas')
              ? await deleteCalendarEventNylas(alvo.grant, inp.title, inp.datetime)
              : await deleteCalendarEvent(alvo.token, inp.title, inp.datetime);
            actionConfirm += ok ? ('✅ "' + inp.title + '" cancelado.\n') : ('⚠️ Não encontrei "' + inp.title + '" para cancelar.\n');
          }
        }
      } catch (e) { console.error('TOOL ERR:', tu.name, e.message); actionConfirm += '⚠️ Erro ao processar a ação.\n'; }
    }
    if (actionConfirm) finalReply = actionConfirm.trim();

    // ── Salva histórico ───────────────────────────────────────────────────

    await saveMessage(phone, 'user', userMessage);
    await saveMessage(phone, 'assistant', finalReply);

    const msgToSend = finalReply || '✅ Feito!';
    await sendWhatsApp(phone, msgToSend);

    // ── Tracking de uso ───────────────────────────────────────────────────
    if (userId) {
      trackUsage(userId, 'whatsapp', { audio: hasAudio, image: !!hasMedia }).catch(console.error);
    }

    return res.status(200).send('OK');

  } catch (err) {
    console.error('ERR:', err.message);
    await sendWhatsApp(phone, 'Erro: ' + err.message);
    return res.status(200).send('OK');
  }
}
