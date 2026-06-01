/**
 * Pallyum — Autenticação de admin
 *
 * readSession: cópia LITERAL de api/asaas/checkout.js — não alterar.
 * isAdmin:     verifica se uid pertence ao admin.
 * requireAdmin: atalho legado — retorna uid se válido+admin; null caso contrário.
 *
 * Nas rotas use readSession + isAdmin para distinguir 401 (sem sessão) de
 * 403 (sessão válida mas não é admin).
 */

import { createHmac, timingSafeEqual } from 'crypto';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '68768231-551e-45b2-8f03-db5848f00fd6';

function toBase64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function readSession(req) {
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

/**
 * isAdmin(uid) → boolean
 * Retorna true se o uid pertencer ao admin configurado.
 */
export function isAdmin(uid) {
  return uid === ADMIN_USER_ID;
}

/**
 * requireAdmin(req) → uid (string) | null
 * Atalho: retorna uid se sessão válida + admin; null caso contrário.
 * Não distingue 401 de 403 — use readSession + isAdmin quando isso importar.
 */
export function requireAdmin(req) {
  const uid = readSession(req);
  if (!uid) return null;
  if (!isAdmin(uid)) return null;
  return uid;
}
