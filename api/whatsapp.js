import { createClient } from '@supabase/supabase-js';

// ── HELPERS ────────────────────────────────────────────────────────────────
function twimlResponse(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;
}

async function transcribeAudio(mediaUrl, accountSid, authToken) {
  // Twilio media requires auth to download
  const response = await fetch(mediaUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    }
  });
  const buffer = await response.arrayBuffer();

  // Send to Whisper via OpenAI for transcription
  // For now returns placeholder — will integrate Whisper next
  return '[áudio recebido — transcrição em breve]';
}

async function getVaultContext(supabase, limit = 20) {
  const { data } = await supabase
    .from('notes')
    .select('title, content, cluster, tags')
    .order('updated_at', { ascending: false })
    .limit(limit);
  return data || [];
}

async function getConversationHistory(supabase, phone, limit = 10) {
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('role, content')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

async function saveMessage(supabase, phone, role, content) {
  await supabase.from('whatsapp_messages').insert({
    phone,
    role,
    content,
    created_at: new Date().toISOString(),
  });
}

async function saveNoteToVault(supabase, note) {
  const id = 'wa-' + Date.now();
  await supabase.from('notes').insert({
    id,
    title: note.title,
    content: note.content,
    folder: note.folder || 'inbox',
    cluster: note.cluster || 'inbox',
    tags: note.tags || ['whatsapp'],
    date: 'agora',
    updated_at: new Date().toISOString(),
  });
  return id;
}

async function callClaude(systemPrompt, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await response.json();
  return data.content?.[0]?.text || 'Não entendi. Pode repetir?';
}

// ── MAIN HANDLER ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(405).send(twimlResponse('Método não permitido.'));
  }

  const {
    Body: body = '',
    From: from = '',
    MediaUrl0: mediaUrl,
    MediaContentType0: mediaType,
    NumMedia: numMedia = '0',
  } = req.body || {};

  const phone = from.replace('whatsapp:', '');

  // init Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. Determina o conteúdo da mensagem
    let userMessage = body.trim();

    // Se for áudio, tenta transcrever
    if (parseInt(numMedia) > 0 && mediaType?.includes('audio')) {
      const transcription = await transcribeAudio(
        mediaUrl,
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      userMessage = transcription;
    }

    if (!userMessage) {
      return res.send(twimlResponse('Recebi sua mensagem! Envie texto ou áudio.'));
    }

    // 2. Busca contexto do vault e histórico
    const [vaultNotes, history] = await Promise.all([
      getVaultContext(supabase),
      getConversationHistory(supabase, phone),
    ]);

    const vaultText = vaultNotes.map(n =>
      `### ${n.title}\nCluster: ${n.cluster}\n${(n.content || '').substring(0, 300)}`
    ).join('\n---\n');

    // 3. Monta system prompt
    const systemPrompt = `Você é o Jarvis — assistente pessoal inteligente acessado via WhatsApp.
Você tem acesso ao vault completo do usuário com todas as suas notas, projetos e decisões.

INSTRUÇÕES:
- Responda em português brasileiro, de forma concisa (máximo 3 parágrafos)
- Seja direto e prático — o usuário está no WhatsApp, não quer textos longos
- Quando o usuário mencionar uma reunião, lead, decisão ou ideia → salve como nota (inclua [SALVAR_NOTA] no final da resposta seguido de JSON)
- Quando o usuário pedir informação do vault → consulte as notas abaixo e responda
- Trate o usuário como parceiro, não como chefe
- Use emojis com moderação para humanizar

FORMATO PARA SALVAR NOTA (quando necessário):
[SALVAR_NOTA]{"title":"...","content":"...","cluster":"produto|estrategia|equipe|pessoal|inbox","folder":"inbox","tags":["..."]}

VAULT DO USUÁRIO (${vaultNotes.length} notas):
${vaultText}`;

    // 4. Monta histórico de conversa
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    // 5. Chama Claude
    console.log('VAULT SIZE:', vaultNotes.length);
    console.log('HISTORY SIZE:', history.length);
    console.log('USER MESSAGE:', userMessage);
    console.log('SYSTEM PROMPT LENGTH:', systemPrompt.length);
    const rawReply = await callClaude(systemPrompt, messages);
    console.log('RAW REPLY:', rawReply);

    // 6. Verifica se Claude quer salvar uma nota
    let reply = rawReply;
    console.log('FINAL REPLY:', reply);
    if (rawReply.includes('[SALVAR_NOTA]')) {
      const parts = rawReply.split('[SALVAR_NOTA]');
      reply = parts[0].trim();
      try {
        const noteJson = parts[1].trim();
        const note = JSON.parse(noteJson);
        await saveNoteToVault(supabase, note);
        reply += '\n\n✅ Nota salva no seu vault!';
      } catch (e) {
        console.error('Error parsing note JSON:', e);
      }
    }

    // 7. Salva histórico
    await Promise.all([
      saveMessage(supabase, phone, 'user', userMessage),
      saveMessage(supabase, phone, 'assistant', reply),
    ]);

    // 8. Responde no WhatsApp
    return res.send(twimlResponse(reply));

  } catch (error) {
    console.error('Webhook error:', error.message, error.stack);
    return res.send(twimlResponse('Erro: ' + error.message));
  }
}
