export default async function handler(req, res) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      realtime: { disabled: true },
      global: { fetch: fetch }
    }
  );

  const code = req.query.code;
  const phone = req.query.state || '';

  if (!code) return res.redirect('/app');

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data?.session) {
      console.error('OAuth error:', error?.message);
      return res.redirect('/app');
    }

    const session = data.session;
    const userId = session.user.id;
    const email = session.user.email;
    const providerToken = session.provider_token;
    const providerRefresh = session.provider_refresh_token;

    console.log('OAuth callback | user:', email, '| phone:', phone, '| has_token:', !!providerToken);

    if (providerToken) {
      const { error: upsertError } = await supabase
        .from('google_tokens')
        .upsert({
          user_id: userId,
          email: email,
          phone: phone || null,
          access_token: providerToken,
          refresh_token: providerRefresh || null,
          expiry_date: Date.now() + 3600 * 1000,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

      if (upsertError) {
        console.error('Token save error:', upsertError.message);
      } else {
        console.log('Google tokens saved for:', email, '| phone:', phone);
      }
    }

    return res.redirect('https://mykoreo.com.br/app');
  } catch(e) {
    console.error('Callback error:', e.message);
    return res.redirect('https://mykoreo.com.br/app');
  }
}
