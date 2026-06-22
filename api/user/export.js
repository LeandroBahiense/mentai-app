/**
 * Pallyum — Export do vault (LGPD Art.18 / portabilidade)
 *
 * POST /api/user/export
 *
 * Gera um ZIP com: notas (.md Obsidian) + metadata.json + conversations.json +
 * attachments/ + README.txt, sobe pro Storage e devolve link assinado de 24h.
 *
 * Identidade: cookie pallyum_session. Sem sessão → 401.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import JSZip from 'jszip';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Helpers de sessão — CÓPIA LITERAL de api/asaas/checkout.js ───────────────

function toBase64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readSession(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)pallyum_session=([^;]+)/);
  if (!match) return null;
  const cookieVal = match[1];
  const dot = cookieVal.lastIndexOf('.');
  if (dot === -1) return null;
  const payloadB64  = cookieVal.slice(0, dot);
  const sigReceived = cookieVal.slice(dot + 1);
  const expectedSig = toBase64url(createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest());
  try {
    const a = Buffer.from(sigReceived);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.uid || typeof payload.uid !== 'string') return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload.uid;
}

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

// ── Utilitários de formatação ────────────────────────────────────────────────

function slug(s) {
  const out = String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'sem-titulo';
}

// tags pode ser array / jsonb / texto → normaliza pra lista de strings
function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') {
    const s = tags.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(t => String(t).trim()).filter(Boolean); } catch {}
    }
    return s.split(',').map(t => t.trim()).filter(Boolean);
  }
  if (tags && typeof tags === 'object') {
    try { return Object.values(tags).map(t => String(t).trim()).filter(Boolean); } catch { return []; }
  }
  return [];
}

function yamlStr(v) {
  return '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function frontmatter(note, tagsArr, dateVal) {
  const tagsYaml = '[' + tagsArr.map(t => yamlStr(t)).join(', ') + ']';
  return [
    '---',
    'title: '      + yamlStr(note.title || ''),
    'tags: '       + tagsYaml,
    'folder: '     + yamlStr(note.folder || ''),
    'cluster: '    + yamlStr(note.cluster || ''),
    'date: '       + yamlStr(dateVal),
    'updated_at: ' + yamlStr(note.updated_at || ''),
    '---',
    '',
  ].join('\n');
}

// Token curto determinístico a partir do path (a select de files não inclui id) —
// usado só pra desambiguar colisão de nome de anexo.
function shortToken(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h.toString(16).slice(0, 6);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // 1. Notas
    const notesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/notes?user_id=eq.${encodeURIComponent(uid)}&select=*`,
      { headers: svcHeaders() }
    );
    if (!notesRes.ok) {
      console.error('[export] GET notes falhou:', notesRes.status);
      return res.status(500).json({ error: 'internal error' });
    }
    const notes = (await notesRes.json().catch(() => [])) || [];

    // 2. Telefones → conversas (whatsapp_messages é chaveada por phone, não user_id)
    const phoneRes = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_users?user_id=eq.${encodeURIComponent(uid)}&select=phone`,
      { headers: svcHeaders() }
    );
    const phoneRows = phoneRes.ok ? (await phoneRes.json().catch(() => [])) : [];
    const phones = (Array.isArray(phoneRows) ? phoneRows : []).map(r => r.phone).filter(Boolean);

    let conversations = [];
    if (phones.length) {
      const inList = phones.map(p => encodeURIComponent(p)).join(',');
      const convRes = await fetch(
        `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=in.(${inList})&order=created_at.asc&select=phone,role,content,created_at`,
        { headers: svcHeaders() }
      );
      conversations = convRes.ok ? ((await convRes.json().catch(() => [])) || []) : [];
    }

    // 3. Anexos
    const filesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/files?user_id=eq.${encodeURIComponent(uid)}&select=path,name,note_id,mime_type`,
      { headers: svcHeaders() }
    );
    const fileRows = filesRes.ok ? ((await filesRes.json().catch(() => [])) || []) : [];

    // 4. Monta o ZIP
    const zip = new JSZip();

    // 4a. Anexos primeiro (resolve nomes finais → usados na metadata)
    const usedNames = new Set();
    const attachmentsByNote = {};
    let addedAttachments = 0;
    for (const f of (Array.isArray(fileRows) ? fileRows : [])) {
      if (!f?.path) continue;
      let finalName = f.name || f.path.split('/').pop() || 'arquivo';
      if (usedNames.has(finalName)) finalName = shortToken(f.path) + '-' + finalName;
      let guard = 0;
      while (usedNames.has(finalName) && guard < 50) {
        finalName = shortToken(f.path + ':' + guard) + '-' + (f.name || 'arquivo');
        guard++;
      }
      try {
        // path DIRETO, sem encodeURIComponent (os '/' são separadores de objeto)
        const objRes = await fetch(SUPABASE_URL + '/storage/v1/object/mentai-files/' + f.path, { headers: svcHeaders() });
        if (!objRes.ok) {
          console.error('[export] download anexo falhou (segue) path=' + f.path + ' status=' + objRes.status);
          continue;
        }
        const bytes = Buffer.from(await objRes.arrayBuffer());
        zip.file('attachments/' + finalName, bytes);
        usedNames.add(finalName);
        addedAttachments++;
        if (f.note_id) (attachmentsByNote[f.note_id] = attachmentsByNote[f.note_id] || []).push(finalName);
      } catch (e) {
        console.error('[export] download anexo erro (segue) path=' + f.path + ':', e.message);
      }
    }

    // 4b. Notas .md (frontmatter YAML + content markdown)
    for (const n of (Array.isArray(notes) ? notes : [])) {
      const tagsArr = normalizeTags(n.tags);
      const dateVal = n.created_at || n.date || n.updated_at || '';
      const dir     = n.in_trash ? 'notas/_lixeira/' : 'notas/';
      const fname   = slug(n.title) + '-' + String(n.id || '').slice(0, 8) + '.md';
      zip.file(dir + fname, frontmatter(n, tagsArr, dateVal) + (n.content || ''));
    }

    // 4c. metadata.json
    const metadata = (Array.isArray(notes) ? notes : []).map(n => ({
      id:          n.id,
      title:       n.title || '',
      tags:        normalizeTags(n.tags),
      folder:      n.folder || '',
      cluster:     n.cluster || '',
      date:        n.created_at || n.date || n.updated_at || '',
      updated_at:  n.updated_at || '',
      in_trash:    !!n.in_trash,
      attachments: attachmentsByNote[n.id] || [],
    }));
    zip.file('metadata.json', JSON.stringify(metadata, null, 2));

    // 4d. conversations.json
    zip.file('conversations.json', JSON.stringify(conversations, null, 2));

    // 4e. README.txt
    zip.file(
      'README.txt',
      'Export do vault Pallyum — ' + new Date().toISOString() + '.\n' +
      'O histórico do chat web não está incluído (ele vive apenas no seu navegador, não em nossos servidores).\n' +
      'Cada nota também possui uma leitura de sentido automática (dado técnico interno, derivado do título e do conteúdo, usado para sugerir conexões entre suas notas). Ela não é legível por pessoas e é apagada junto com a nota — por isso não vai neste pacote.\n'
    );

    // 5. Upload da ZIP
    const ts      = Date.now();
    const zipPath = 'exports/' + uid + '/' + ts + '.zip';
    const buffer  = await zip.generateAsync({ type: 'nodebuffer' });
    const upRes = await fetch(SUPABASE_URL + '/storage/v1/object/mentai-files/' + zipPath, {
      method:  'POST',
      headers: { ...svcHeaders(), 'Content-Type': 'application/zip', 'x-upsert': 'true' },
      body:    buffer,
    });
    if (!upRes.ok) {
      console.error('[export] upload ZIP falhou:', upRes.status, await upRes.text().catch(() => ''));
      return res.status(500).json({ error: 'internal error' });
    }

    // 6. Link assinado de 24h
    const signRes = await fetch(SUPABASE_URL + '/storage/v1/object/sign/mentai-files/' + zipPath, {
      method:  'POST',
      headers: svcHeaders(),
      body:    JSON.stringify({ expiresIn: 86400 }),
    });
    const signData = await signRes.json().catch(() => ({}));
    const url = signData.signedURL ? SUPABASE_URL + '/storage/v1' + signData.signedURL : null;
    if (!url) {
      console.error('[export] sign ZIP falhou:', signRes.status);
      return res.status(500).json({ error: 'internal error' });
    }

    // 7. Auditoria — não-bloqueante.
    try {
      const auditResp = await fetch(`${SUPABASE_URL}/rest/v1/admin_audit`, {
        method:  'POST',
        headers: { ...svcHeaders(), 'Prefer': 'return=minimal' },
        body:    JSON.stringify({
          admin_user_id:  uid,
          target_user_id: uid,
          action:         'vault_exported',
          old_value:      JSON.stringify(null),
          new_value:      JSON.stringify({ path: zipPath, notes: metadata.length, attachments: addedAttachments, conversations: conversations.length }),
          created_at:     new Date().toISOString(),
        }),
      });
      if (!auditResp.ok) {
        console.error('[export] ⚠️  admin_audit INSERT falhou:', auditResp.status);
      }
    } catch (e) {
      console.error('[export] ⚠️  admin_audit INSERT erro:', e.message);
    }

    // 8. OK
    return res.status(200).json({ url });

  } catch (e) {
    console.error('[export] erro inesperado:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
