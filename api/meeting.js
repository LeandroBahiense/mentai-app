const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const TWILIO_SID           = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN         = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM          = process.env.TWILIO_WHATSAPP_FROM;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  };
}

async function getPhoneUsers() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/phone_users?select=phone,user_id',
    { headers: sbHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function processTranscript(transcriptText) {
  const prompt = [
    'Analise esta transcrição de reunião e extraia as informações estruturadas.',
    'Responda APENAS com JSON puro, sem markdown:',
    '{',
    '  "title": "título da reunião",',
    '  "participants": ["nome1", "nome2"],',
    '  "decisions": ["decisão 1", "decisão 2"],',
    '  "actions": ["ação 1 - responsável", "ação 2 - responsável"],',
    '  "summary": "resumo executivo em 3-4 linhas"',
    '}',
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt + '\n\nTRANSCRIÇÃO:\n' + transcriptText }],
    }),
  });

  const data = await res.json();
  const raw = data.content?.[0]?.text || '{}';
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(cleaned);
}

async function createNoteInVault(meetData, userId) {
  const rawTitle = meetData.title || new Date().toLocaleDateString('pt-BR');
  const title = rawTitle.toLowerCase().startsWith('reuni') ? rawTitle : 'Reunião: ' + rawTitle;

  const noteContent =
    '## Participantes\n' +
    (meetData.participants || []).map(p => '- ' + p).join('\n') + '\n\n' +
    '## Decisões\n' +
    (meetData.decisions || []).map(d => '- ' + d).join('\n') + '\n\n' +
    '## Próximas Ações\n' +
    (meetData.actions || []).map(a => '- [ ] ' + a).join('\n') + '\n\n' +
    '## Resumo\n' +
    (meetData.summary || '');

  const noteId = 'meeting-' + Date.now();
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes', {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      id: noteId,
      title,
      content: noteContent,
      folder: 'reunioes',
      cluster: 'equipe',
      tags: ['reunião', 'fireflies', 'transcrição'],
      user_id: userId,
      updated_at: new Date().toISOString(),
    }),
  });

  console.log('MEETING NOTE CREATED:', res.status, title);
  return { title, noteId };
}

async function sendWhatsApp(to, body) {
  const toFormatted = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toFormatted, Body: body }),
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('MEETING WEBHOOK received');
    const body = req.body;

    // Extrai transcrição do payload do Fireflies
    let transcriptText = '';
    let meetingTitle   = '';

    if (body.transcript) {
      // Formato Fireflies: { transcript: "...", title: "...", ... }
      transcriptText = body.transcript;
      meetingTitle   = body.title || '';
    } else if (body.meeting && body.meeting.transcript) {
      transcriptText = body.meeting.transcript;
      meetingTitle   = body.meeting.title || '';
    } else if (typeof body === 'string') {
      transcriptText = body;
    } else {
      // Tenta extrair qualquer campo de texto longo
      transcriptText = body.text || body.content || body.summary || JSON.stringify(body);
    }

    console.log('TRANSCRIPT LENGTH:', transcriptText.length);
    console.log('MEETING TITLE:', meetingTitle);

    if (!transcriptText || transcriptText.length < 10) {
      return res.status(400).json({ error: 'Transcrição vazia' });
    }

    // Processa com Claude
    const meetData = await processTranscript(transcriptText);
    if (meetingTitle && !meetData.title) meetData.title = meetingTitle;

    // Busca todos os usuários para notificar
    const phoneUsers = await getPhoneUsers();
    console.log('NOTIFYING:', phoneUsers.length, 'users');

    const results = [];
    for (const pu of phoneUsers) {
      try {
        // Cria nota no vault do usuário
        const { title } = await createNoteInVault(meetData, pu.user_id);

        // Notifica no WhatsApp
        const msg = [
          '📋 *Nova reunião registrada no vault!*',
          '',
          '📌 *' + title + '*',
          '👥 ' + (meetData.participants || []).join(', '),
          '✔️ ' + (meetData.decisions || []).length + ' decisão(ões)',
          '📋 ' + (meetData.actions || []).length + ' ação(ões)',
          '',
          '📝 ' + (meetData.summary || '').substring(0, 200),
        ].join('\n');

        await sendWhatsApp(pu.phone, msg);
        results.push({ phone: pu.phone, ok: true });
      } catch (err) {
        console.error('USER ERR:', pu.phone, err.message);
        results.push({ phone: pu.phone, ok: false });
      }
    }

    return res.json({ ok: true, title: meetData.title, results });

  } catch (err) {
    console.error('MEETING WEBHOOK ERR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
