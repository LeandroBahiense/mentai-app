```javascript
const { createClient } = require('@supabase/supabase-js');

function twimlResponse(message) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + message + '</Message></Response>';
}

async function callClaude(apiKey, systemPrompt, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: systemPrompt,
      messages: messages,
    }),
  });
  const data = await response.json();
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text;
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(405).send(twimlResponse('Método não permitido.'));
  }

  const body = req.body || {};
  const userMessage = (body.Body || '').trim();
  const from = (body.From || '').replace('whatsapp:', '');

  console.log('FROM:', from);
  console.log('MESSAGE:', userMessage);

  if (!userMessage) {
    return res.send(twimlResponse('Envie uma mensagem de texto.'));
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data: notes } = await supabase
      .from('notes')
      .select('title, content, cluster')
      .order('updated_at', { ascending: false })
      .limit(15);

    const vault = (notes || []).map(function(n) {
      return '### ' + n.title + '\n' + (n.content || '').substring(0, 200);
    }).join('\n---\n');

    console.log('NOTES COUNT:', (notes || []).length);

    const systemPrompt = 'Você é o Jarvis, assistente pessoal do usuário via WhatsApp. Responda em português, de forma curta e direta (máximo 2 parágrafos). Use as notas abaixo como contexto.\n\nNOTAS DO USUÁRIO:\n' + vault;

    const reply = await callClaude(
      process.env.ANTHROPIC_API_KEY,
      systemPrompt,
      [{ role: 'user', content: userMessage }]
    );

    console.log('REPLY:', reply);

    if (!reply) {
      return res.send(twimlResponse('Não consegui processar sua mensagem. Tente novamente.'));
    }

    await supabase.from('whatsapp_messages').insert({
      phone: from,
      role: 'user',
      content: userMessage,
    });

    await supabase.from('whatsapp_messages').insert({
      phone: from,
      role: 'assistant',
      content: reply,
    });

    return res.send(twimlResponse(reply));

  } catch (error) {
    console.error('ERROR:', error.message);
    return res.send(twimlResponse('Erro interno: ' + error.message));
  }
};
```
