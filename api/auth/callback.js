const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };
}

async function saveTokens(phone, tokens) {
  await fetch(SUPABASE_URL + '/rest/v1/google_tokens', {
    method: 'POST',
    headers: {
      ...sbHeaders(),
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      phone,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date:   Date.now() + tokens.expires_in * 1000,
      updated_at:    new Date().toISOString(),
    }),
  });
}

export default async function handler(req, res) {
  const { code, state: phone, error } = req.query;

  if (error) {
    return res.status(400).send('Autorização negada: ' + error);
  }

  if (!code || !phone) {
    return res.status(400).send('Parâmetros inválidos.');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      return res.status(400).send('Erro ao obter tokens: ' + tokens.error_description);
    }

    await saveTokens(phone, tokens);

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Google conectado com sucesso!</h2>
        <p>Pode fechar esta janela e voltar ao WhatsApp.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('CALLBACK ERR:', err.message);
    return res.status(500).send('Erro interno: ' + err.message);
  }
}
