export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const code = req.query.code;
  const phone = req.query.state || '';

  if (!code) return res.redirect('https://mykoreo.com.br/app');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const tokenData = await tokenRes.json();
    console.log('GOOGLE TOKEN STATUS:', tokenRes.status, '| has_access_token:', !!tokenData.access_token);

    if (!tokenData.access_token) {
      console.error('Google token error:', JSON.stringify(tokenData));
      return res.redirect('https://mykoreo.com.br/app');
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userRes.json();
    const email = userInfo.email;
    console.log('USER EMAIL:', email, '| PHONE:', phone);

    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
    });
    const authData = await authRes.json();
    const userId = authData?.users?.[0]?.id;
    console.log('USER ID:', userId);

    if (userId && tokenData.access_token) {
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
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || null,
          expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000,
          updated_at: new Date().toISOString(),
        }),
      });
      console.log('TOKEN UPSERT STATUS:', upsertRes.status);
    }

    return res.redirect('https://mykoreo.com.br/app');
  } catch(e) {
    console.error('Callback error:', e.message);
    return res.redirect('https://mykoreo.com.br/app');
  }
}
