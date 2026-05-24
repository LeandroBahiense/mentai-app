import { createHmac, timingSafeEqual } from 'crypto';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const uid = readSession(req);
  if (!uid) return res.status(401).json({ error: 'sessão inválida' });

  const { phone, assistantName, displayName } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const msg =
    `Olá, ${displayName || 'você'}! 👋\n\n` +
    `Sou o *${assistantName || 'Jarvis'}*, seu assistente pessoal no Pallyum.\n\n` +
    `Estou aqui para te ajudar com:\n` +
    `📅 Sua agenda do Google Calendar\n` +
    `📝 Suas notas e ideias\n` +
    `⚡ Suas prioridades do dia\n\n` +
    `Me manda uma mensagem quando quiser. Pode começar com: *"o que tenho hoje?"*`;

  const auth = 'Basic ' + Buffer.from(
    process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  ).toString('base64');

  const twilioRes = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: process.env.TWILIO_WHATSAPP_FROM,
        To:   'whatsapp:+' + phone,
        Body: msg,
      }),
    }
  );

  if (twilioRes.status !== 201) {
    const errBody = await twilioRes.text().catch(() => '');
    console.error('[whatsapp-welcome] Twilio error:', twilioRes.status, errBody);
    return res.status(502).json({ error: 'falha ao enviar' });
  }

  return res.status(200).json({ ok: true });
}
