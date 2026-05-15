export default async function handler(req, res) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const code = req.query.code;
  if (!code) return res.redirect('/app');

  try {
    const { data: sessionData } = await supabase.auth.exchangeCodeForSession(code);
    const session = sessionData?.session;
    if (!session) return res.redirect('/app');

    const providerToken   = session.provider_token;
    const providerRefresh = session.provider_refresh_token;
    const userId = session.user.id;
    const email  = session.user.email;

    if (providerToken) {
      await supabase.from('google_tokens').upsert({
        user_id:       userId,
        email:         email,
        access_token:  providerToken,
        refresh_token: providerRefresh || null,
        expiry_date:   Date.now() + 3600 * 1000,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'user_id' });

      console.log('OAuth callback: google_tokens saved for', email);
    }

    return res.redirect('/app');
  } catch (e) {
    console.error('OAuth callback error:', e);
    return res.redirect('/app');
  }
}
