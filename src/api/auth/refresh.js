export default async function handler(req, res) {
  setCORS(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { refresh_token } = body || {};
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token required' });
    }

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refresh_token);
    params.set('client_id', process.env.OAUTH_CLIENT_ID);
    params.set('client_secret', process.env.OAUTH_CLIENT_SECRET);

    const r = await fetch(process.env.OAUTH_TOKEN_URL || 'https://auth.nexiiot.io/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    console.error('refresh error:', e);
    return res.status(500).json({ error: e?.message || 'refresh failed' });
  }
}

function setCORS(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://liff.line.me', 'https://liff-test-finh.vercel.app'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[1]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
