// src/api/line/token.js
// Exchange LINE authorization code -> { access_token, id_token, ... }
// and (optionally) verify id_token to append { userId }

module.exports = async (req, res) => {
  try {
    // CORS preflight (ถ้าเรียกจากเว็บ)
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
      LINE_LOGIN_CHANNEL_ID,
      LINE_LOGIN_CHANNEL_SECRET,
    } = process.env;

    if (!LINE_LOGIN_CHANNEL_ID || !LINE_LOGIN_CHANNEL_SECRET) {
      return res.status(500).json({ error: 'LINE env missing: set LINE_LOGIN_CHANNEL_ID & LINE_LOGIN_CHANNEL_SECRET' });
    }

    // parse JSON body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { code, redirect_uri, code_verifier } = body;

    if (!code || !redirect_uri) {
      return res.status(400).json({ error: 'code & redirect_uri required' });
    }

    // Build x-www-form-urlencoded payload
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', redirect_uri); // MUST EXACTLY MATCH the one used at authorize time
    params.set('client_id', LINE_LOGIN_CHANNEL_ID);
    params.set('client_secret', LINE_LOGIN_CHANNEL_SECRET);
    if (code_verifier) params.set('code_verifier', code_verifier); // if you use PKCE

    // Exchange code -> token
    const tokenResp = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const tokenText = await tokenResp.text();
    let tokenJson;
    try { tokenJson = JSON.parse(tokenText); }
    catch { return res.status(tokenResp.status).send(tokenText); }

    // Pass-through errors from LINE (e.g., invalid_grant, redirect_uri mismatch)
    if (!tokenResp.ok) {
      return res.status(tokenResp.status).json(tokenJson);
    }

    // If we got an id_token and want to verify it (recommended)
    if (tokenJson.id_token) {
      try {
        const verifyParams = new URLSearchParams();
        verifyParams.set('id_token', tokenJson.id_token);
        verifyParams.set('client_id', LINE_LOGIN_CHANNEL_ID);

        const verifyResp = await fetch('https://api.line.me/oauth2/v2.1/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: verifyParams.toString(),
        });

        const verifyJson = await verifyResp.json();
        if (verifyResp.ok && verifyJson && verifyJson.sub) {
          tokenJson.userId = verifyJson.sub;   // LINE userId (Uxxxxxxxx...)
          tokenJson.idTokenPayload = verifyJson; // OPTIONAL: useful for debugging/profile claims
        } else {
          // If verify fails, still return tokens but include reason
          tokenJson.idTokenVerifyError = verifyJson?.error_description || verifyJson?.error || 'verify failed';
        }
      } catch (e) {
        tokenJson.idTokenVerifyError = e.message || 'verify error';
      }
    }

    // Done
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(tokenJson);
  } catch (e) {
    console.error('line/token error:', e);
    return res.status(500).json({ error: e.message || 'exchange failed' });
  }
};
