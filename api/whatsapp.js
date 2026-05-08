const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };
}

function twiml(msg) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + msg + '</Message></Response>';
}

async function getNotes() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/notes?select=title,content,cluster&order=updated_at.desc&limit=15', {
    headers: sbHeaders()
  });
  return await res.json();
}

async function saveMessage(phone, role, content) {
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_messages', {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ phone, role, content })
  });
}

async function getHistory(phone) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/whatsapp_messages?phone=eq.' + encodeURIComponent(phone) + '&order=created_at.desc&limit=10&select=role,content', {
    headers: sbHeaders()
  });
  const data = await res.json();
  return Array.isArray(data) ? data.reverse() : [];
}

async function transcribeAudio(mediaUrl, contentType) {
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const audioRes = await fetch(mediaUrl, {
    headers: { 'Authorization': 'Basic ' + auth }
  });

  if (!audioRes.ok) {
    throw new Error('Erro ao baixar áudio do Twilio: ' + audioRes.status);
  }

  const audioBuffer = await audioRes.arrayBuffer();

  const ext = contentType.includes('ogg') ? 'ogg'
    : contentType.includes('mp4') ? 'mp4'
    : contentType.includes('mpeg') ? 'mp3'
    : 'ogg';

  console.log('WHISPER: enviando áudio', ext, audioBuffer.byteLength, 'bytes');

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: contentType }), 'audio.' + ext);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: form
  });

  console.log('WHISPER STATUS:', whisperRes.status);
  const whisperData = await whisperRes.json();
  console.log('WHISPER RESPONSE:', JSON.stringify(whisperData));

  return whisperData.text || null;
}

async function askClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: system,
      messages: messages,
    })
  });
  console.log('CLAUDE STATUS:', res.status);
  const data = await res.json();
  console.log('CLAUDE RESPONSE:', JSON.stringify(data));
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text;
  }
  if (data.error) {
    console.error('CLAUDE ERROR:', data.error);
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  if (req.method !== 'POST') return res.status(405).send(twiml('Método não permitido.'));

  const body = req.body || {};
  const phone = (body.From || '').replace('whatsapp:', '');
  const mediaUrl = body.MediaUrl0 || '';
  const mediaType = (body.MediaContentType0 || '').toLowerCase();
  const hasAudio = mediaType.startsWith('audio/') && mediaUrl;

  let userMessage = (body.Body || '').trim();

  console.log('FROM:', phone, 'MSG:', userMessage, 'AUDIO:', hasAudio ? mediaType : 'none');

  if (hasAudio) {
    try {
      const transcription = await transcribeAudio(mediaUrl, mediaType);
      if (transcription) {
        userMessage = transcription;
        console.log('TRANSCRIPTION:', userMessage);
      } else {
        return res.send(twiml('Não consegui transcrever o áudio. Tente enviar uma mensagem de texto.'));
      }
    } catch (err) {
      console.error('TRANSCRIBE ERR:', err.message);
      return res.send(twiml('Erro ao processar áudio: ' + err.message));
    }
  }

  if (!userMessage) return res.send(twiml('Envie uma mensagem de texto ou áudio.'));

  try {
    const [notes, history] = await Promise.all([getNotes(), getHistory(phone)]);

    const vault = Array.isArray(notes) ? notes.map(function(n) {
      return '### ' + n.title + '\n' + (n.content || '').substring(0, 250);
    }).join('\n---\n') : '';

    console.log('NOTES:', Array.isArray(notes) ? notes.length : 0);

    const system = 'Você é o Jarvis, assistente pessoal via WhatsApp. Responda em português, de forma curta (máximo 2 parágrafos). Use as notas abaixo como contexto.\n\nNOTAS:\n' + vault;

    const msgs = history.map(function(m) {
      return { role: m.role, content: m.content };
    }).concat([{ role: 'user', content: userMessage }]);

    const reply = await askClaude(system, msgs);
    console.log('REPLY:', reply);

    if (!reply) return res.send(twiml('Não consegui processar. Tente novamente.'));

    await saveMessage(phone, 'user', userMessage);
    await saveMessage(phone, 'assistant', reply);

    return res.send(twiml(reply));
  } catch (err) {
    console.error('ERR:', err.message);
    return res.send(twiml('Erro: ' + err.message));
  }
}
