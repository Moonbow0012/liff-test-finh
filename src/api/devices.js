const auth = require('./_lib/auth'); // ⬅️ ไม่ destructure

function allowedList() {
  const env = (process.env.ALLOWED_DEVICE_IDS || '').trim();
  const ids = env
    ? env.split(',').map(s => s.trim()).filter(Boolean)
    : [
        '20b1b470-a0b4-412a-890d-fa87380183c6',
        '3e3fe3eb-7677-4585-bd02-fb4b53793a33'
      ];
  return ids.map(id => ({ name: id.slice(0,8), deviceId: id }));
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const idToken = req.headers['x-line-id-token'];
    await auth.verifyLineIdToken(idToken, process.env.LINE_LOGIN_CHANNEL_ID);

    return res.status(200).json({ devices: allowedList() });
  } catch (e) {
    return res.status(401).json({ error: e.message || 'unauthorized' });
  }
};
