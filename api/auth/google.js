export default function handler(req, res) {
  const userId = req.query.user_id || '';
  const phone  = req.query.phone  || '';

  const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  // Codifica user_id + phone em base64 pra sobreviver ao redirect sem expor na URL
  const state = Buffer.from(JSON.stringify({ user_id: userId, phone })).toString('base64');

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         scopes,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });

  return res.redirect(
    'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
  );
}
