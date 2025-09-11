// Verify LINE idToken -> return lineUserId (sub)
async function verifyLineIdToken(idToken, clientId) {
  if (!idToken) throw new Error('idToken missing');
  const params = new URLSearchParams();
  params.set('id_token', idToken);
  params.set('client_id', clientId);
  const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || 'LINE verify failed');
  return data.sub; // LINE userId
}

// ⬅️ CommonJS export (สำคัญ)
module.exports = { verifyLineIdToken };
