const { verifyLineIdToken } = require('./_lib/auth');
const { getServiceAuthHeader } = require('./_lib/nxToken');

function isAllowed(deviceId) {
  const env = (process.env.ALLOWED_DEVICE_IDS || '').trim();
  const ids = env
    ? env.split(',').map(s => s.trim())
    : [
        '20b1b470-a0b4-412a-890d-fa87380183c6',
        '3e3fe3eb-7677-4585-bd02-fb4b53793a33'
      ];
  return ids.includes(deviceId);
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // 1) ยืนยันตัวตนด้วย LINE idToken
    const idToken = req.headers['x-line-id-token'];
    await verifyLineIdToken(idToken, process.env.LINE_LOGIN_CHANNEL_ID);

    // 2) รับ GraphQL query/variables จาก client (ไม่รับ access_token แล้ว)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { query, variables } = body || {};
    if (!query) return res.status(400).json({ error: 'query required' });

    // 3) บังคับเฉพาะ device ที่อนุญาต (กันยิงข้ามฟาร์ม)
    const deviceId = variables && variables.deviceid;
    if (deviceId && !isAllowed(deviceId)) {
      return res.status(403).json({ error: 'forbidden device' });
    }

    // 4) ใช้ service token ของระบบ proxy ไป NexIIoT
    const auth = await getServiceAuthHeader();
    const r = await fetch(process.env.NX_GRAPHQL_URL || 'https://gqlv2.nexiiot.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': auth },
      body: JSON.stringify({ query, variables })
    });

    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    console.error('gql error:', e);
    return res.status(500).json({ error: e.message || 'gql failed' });
  }
};
