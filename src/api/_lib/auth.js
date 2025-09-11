// Verify ด้วย id_token (JWT จาก OpenID)
async function verifyLineIdToken(idToken, clientId) {
  if (!idToken) throw new Error('idToken missing');
  if (!idToken.includes('.')) throw new Error('invalid id_token format');
  if (!clientId) throw new Error('clientId missing');
  const params = new URLSearchParams();
  params.set('id_token', idToken);
  params.set('client_id', clientId);
  const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || 'LINE verify failed');
  return data.sub; // LINE userId
}

// Fallback: Verify ด้วย access_token (ต้องมี scope "profile")
async function verifyLineAccessToken(accessToken) {
  if (!accessToken) throw new Error('accessToken missing');
  const r = await fetch('https://api.line.me/v2/profile', {
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && (data.error || data.message)) || 'profile failed');
  // data.userId มีรูปแบบ Uxxxxxxxx...
  return data.userId;
}

// รับ token จาก header: x-line-id-token หรือ x-line-access-token
async function verifyFromHeaders(req) {
  const idt = req.headers['x-line-id-token'];
  const act = req.headers['x-line-access-token'];
  const cid = process.env.LINE_LOGIN_CHANNEL_ID;
  if (idt) return verifyLineIdToken(idt, cid);
  if (act) return verifyLineAccessToken(act);
  throw new Error('no LINE token provided');
}

module.exports = { verifyLineIdToken, verifyLineAccessToken, verifyFromHeaders };
