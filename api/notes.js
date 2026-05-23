const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const sbRes = await fetch(
      SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/notes?order=updated_at.desc',
      {
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + token,
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!sbRes.ok) {
      const msg = await sbRes.text().catch(() => '');
      return res.status(sbRes.status).json({ error: 'Supabase error: ' + msg });
    }

    const notes = await sbRes.json();
    return res.status(200).json(notes);

  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return res.status(504).json({ error: 'Supabase request timed out' });
    }
    console.error('[api/notes] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
