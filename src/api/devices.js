// src/api/devices.js  (CommonJS)
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ถ้ามี ENV ใช้จาก ENV; ไม่มีก็ fallback เป็น 2 ตัวที่คุณให้มา
  const env = (process.env.ALLOWED_DEVICE_IDS || '').trim();
  const ids = env
    ? env.split(',').map(s => s.trim()).filter(Boolean)
    : [
        '20b1b470-a0b4-412a-890d-fa87380183c6',
        '3e3fe3eb-7677-4585-bd02-fb4b53793a33'
      ];

  const devices = ids.map(id => ({ name: id.slice(0, 8), deviceId: id }));
  return res.status(200).json({ devices });
};
