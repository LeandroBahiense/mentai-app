import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

function twimlResponse(message) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + message + '</Message></Response>';
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

async function callClaude(apiKey, systemPrompt, userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
async function askClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'x-api-key': ANTHROPIC_KEY,
'anthropic-version': '2023-06-01',
},
body: JSON.stringify({
model: 'claude-sonnet-4-20250514',
max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
      system: system,
      messages: messages,
    })
});
  const data = await response.json();
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text;
  }
  return null;
  const data = await res.json();
  return data.content && data.content[0] ? data.content[0].text : null;
}

export default async function handler(req, res) {
res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(405).send(twimlResponse('Método não permitido.'));
  }
  if (req.method !== 'POST') return res.status(405).send(twiml('Método não permitido.'));

const body = req.body || {};
const userMessage = (body.Body || '').trim();
  const from = (body.From || '').replace('whatsapp:', '');
  const phone = (body.From || '').replace('whatsapp:', '');

  console.log('FROM:', from);
  console.log('MESSAGE:', userMessage);
  console.log('FROM:', phone, 'MSG:', userMessage);

  if (!userMessage) {
    return res.send(twimlResponse('Envie uma mensagem de texto.'));
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.send(twimlResponse('API key não configurada.'));
  }
  if (!userMessage) return res.send(twiml('Envie uma mensagem de texto.'));

try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false },
        realtime: { enabled: false },
        global: {
          headers: { 'x-my-custom-header': 'mentai-whatsapp' }
        }
      }
    );

    const { data: notes } = await supabase
      .from('notes')
      .select('title, content, cluster')
      .order('updated_at', { ascending: false })
      .limit(15);

    const vault = (notes || []).map(n =>
      '### ' + n.title + '\n' + (n.content || '').substring(0, 200)
    ).join('\n---\n');

    console.log('NOTES COUNT:', (notes || []).length);

    const systemPrompt = 'Você é o Jarvis, assistente pessoal do usuário via WhatsApp. Responda em português, de forma curta e direta (máximo 2 parágrafos). Use as notas abaixo como contexto.\n\nNOTAS DO USUÁRIO:\n' + vault;

    const reply = await callClaude(apiKey, systemPrompt, userMessage);
    const [notes, history] = await Promise.all([getNotes(), getHistory(phone)]);

    console.log('REPLY:', reply);
    const vault = Array.isArray(notes) ? notes.map(function(n) {
      return '### ' + n.title + '\n' + (n.content || '').substring(0, 250);
    }).join('\n---\n') : '';

    console.log('NOTES:', Array.isArray(notes) ? notes.length : 0);

    const system = 'Você é o Jarvis, assistente pessoal via WhatsApp. Responda em português, de forma curta (máximo 2 parágrafos). Use as notas abaixo como contexto.\n\nNOTAS:\n' + vault;

    if (!reply) {
      return res.send(twimlResponse('Não consegui processar sua mensagem. Tente novamente.'));
    }
    const msgs = history.map(function(m) {
      return { role: m.role, content: m.content };
    }).concat([{ role: 'user', content: userMessage }]);

    const reply = await askClaude(system, msgs);
    console.log('REPLY:', reply);

    await supabase.from('whatsapp_messages').insert({ phone: from, role: 'user', content: userMessage });
    await supabase.from('whatsapp_messages').insert({ phone: from, role: 'assistant', content: reply });
    if (!reply) return res.send(twiml('Não consegui processar. Tente novamente.'));

    return res.send(twimlResponse(reply));
    await saveMessage(phone, 'user', userMessage);
    await saveMessage(phone, 'assistant', reply);

  } catch (error) {
    console.error('ERROR:', error.message);
    return res.send(twimlResponse('Erro interno: ' + error.message));
    return res.send(twiml(reply));
  } catch (err) {
    console.error('ERR:', err.message);
    return res.send(twiml('Erro: ' + err.message));
}
}
