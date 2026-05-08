export default function handler(req, res) {
  const phone = req.query.phone || '';

  if (!phone) {
    return res.status(400).send('Parâmetro phone obrigatório.');
  }

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type:   'offline',
    prompt:        'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ].join(' '),
    state: phone,
  });

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  return res.redirect(302, url);
}
