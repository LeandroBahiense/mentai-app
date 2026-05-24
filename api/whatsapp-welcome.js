export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { phone, assistantName, displayName } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const client = (await import('twilio')).default(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const msg =
    `Olá, ${displayName || 'você'}! 👋\n\n` +
    `Sou o *${assistantName || 'Jarvis'}*, seu assistente pessoal no Pallyum.\n\n` +
    `Estou aqui para te ajudar com:\n` +
    `📅 Sua agenda do Google Calendar\n` +
    `📝 Suas notas e ideias\n` +
    `⚡ Suas prioridades do dia\n\n` +
    `Me manda uma mensagem quando quiser. Pode começar com: *"o que tenho hoje?"*`;

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to:   'whatsapp:+' + phone,
    body: msg,
  });

  return res.status(200).json({ ok: true });
}
