/**
 * Pallyum — limite de contas de calendário do usuário (03.4a).
 * GET autenticado (cookie pallyum_session) → checkAccountLimit(uid).
 * Admin e design_partner voltam com atLimit:false (bypass).
 */

import { readSession } from './_lib/adminAuth.js';
import { checkAccountLimit } from './_lib/plans.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  try {
    const result = await checkAccountLimit(uid);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[account-limits] erro:', e.message);
    return res.status(500).json({ error: 'erro ao verificar limite' });
  }
}
