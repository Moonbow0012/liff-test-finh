function setCORS(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://liff.line.me', 'https://liff-test-finh.vercel.app'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[1]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  try {
    setCORS(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { query, variables, access_token } = body || {};
    if (!query || !access_token) return res.status(400).json({ error: 'query & access_token required' });

    const r = await fetch(process.env.NX_GRAPHQL_URL || 'https://gqlv2.nexiiot.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
      body: JSON.stringify({ query, variables }),
    });

    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    console.error('gql error:', e);
    return res.status(500).json({ error: e?.message || 'gql failed' });
  }
};
