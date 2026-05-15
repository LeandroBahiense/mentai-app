export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const code = req.query.code;
  const phone = req.query.state || '';

  if (!code) return res.redirect('https://mykoreo.com.br/app');

  try {
    // troca o code por sessão via REST
    const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ auth_code: code }),
    });

    const tokenData = await tokenRes.json();
    console.log('TOKEN RESPONSE:', tokenRes.status, JSON.stringify(tokenData).substring(0, 200));

    if (!tokenData.access_token) {
      console.error('No access token returned');
      return res.redirect('https://mykoreo.com.br/app');
    }

    const userId = tokenData.user?.id;
    const email = tokenData.user?.email;
    const providerToken = tokenData.provider_token;
    const providerRefresh = tokenData.provider_refresh_token;

    console.log('User:', email, '| phone:', phone, '| has_provider_token:', !!providerToken);

    if (providerToken && userId) {
      const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          user_id: userId,
          email: email,
          phone: phone || null,
          access_token: providerToken,
          refresh_token: providerRefresh || null,
          expiry_date: Date.now() + 3600 * 1000,
          updated_at: new Date().toISOString(),
        }),
      });
      console.log('Token upsert status:', upsertRes.status);
    }

    return res.redirect('https://mykoreo.com.br/app');
  } catch(e) {
    console.error('Callback error:', e.message);
    return res.redirect('https://mykoreo.com.br/app');
  }
}
