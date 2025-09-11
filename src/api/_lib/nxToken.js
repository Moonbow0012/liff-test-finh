let _access = null, _refresh = null, _exp = 0;
const nowSec = () => Math.floor(Date.now()/1000);
const willExpireSoon = () => !_access || (_exp - nowSec() <= 60);

async function fetchTokenPassword() {
  const { OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SERVICE_USERNAME, SERVICE_PASSWORD } = process.env;
  if (!SERVICE_USERNAME || !SERVICE_PASSWORD) throw new Error('SERVICE_USERNAME/PASSWORD missing');
  const params = new URLSearchParams();
  params.set('grant_type','password');
  params.set('username', SERVICE_USERNAME);
  params.set('password', SERVICE_PASSWORD);
  const basic = 'Basic ' + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(OAUTH_TOKEN_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json', 'Authorization': basic },
    body: params.toString()
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'oauth failed');
  _access = j.access_token; _refresh = j.refresh_token || null; _exp = nowSec() + (j.expires_in || 3600);
}
async function refreshToken() {
  const { OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } = process.env;
  if (!_refresh) return fetchTokenPassword();
  const params = new URLSearchParams();
  params.set('grant_type','refresh_token');
  params.set('refresh_token', _refresh);
  const basic = 'Basic ' + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(OAUTH_TOKEN_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json', 'Authorization': basic },
    body: params.toString()
  });
  const j = await r.json();
  if (!r.ok) return fetchTokenPassword();
  _access = j.access_token; _refresh = j.refresh_token || _refresh; _exp = nowSec() + (j.expires_in || 3600);
}
async function getServiceAuthHeader() {
  if (!_access || willExpireSoon()) {
    try { await refreshToken(); } catch { await fetchTokenPassword(); }
  }
  return 'Bearer ' + _access;
}
module.exports = { getServiceAuthHeader };
