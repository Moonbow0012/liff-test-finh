const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(morgan('dev'));

// อนุญาตโดเมน LIFF/เว็บคุณ (แก้เป็นโดเมนจริง เช่น Vercel ของคุณ)
app.use(cors({
  origin: [
    'https://liff.line.me',
    'https://liff-test-finh.vercel.app'
  ],
}));

// ===== ENV =====
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || 'https://auth.nexiiot.io/oauth/token';
const NX_GRAPHQL_URL  = process.env.NX_GRAPHQL_URL  || 'https://gqlv2.nexiiot.io/graphql';
const CLIENT_ID       = process.env.OAUTH_CLIENT_ID;   // <-- ใส่ใน .env
const CLIENT_SECRET   = process.env.OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('⚠️ Missing OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET in .env');
}

// Password Grant
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username & password required' });

    const params = new URLSearchParams();
    params.set('grant_type', 'password');
    params.set('username', username);
    params.set('password', password);
    params.set('client_id', CLIENT_ID);
    params.set('client_secret', CLIENT_SECRET);

    const { data } = await axios.post(OAUTH_TOKEN_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    res.json(data); // { access_token, refresh_token, expires_in, token_type, ... }
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

// Refresh Token
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refresh_token);
    params.set('client_id', CLIENT_ID);
    params.set('client_secret', CLIENT_SECRET);

    const { data } = await axios.post(OAUTH_TOKEN_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

// Proxy GraphQL (หน้าเว็บเรียก /gql -> proxy ยิงไปยัง NexIIoT)
app.post('/gql', async (req, res) => {
  try {
    const { query, variables, access_token } = req.body || {};
    if (!query || !access_token) return res.status(400).json({ error: 'query & access_token required' });

    const { data } = await axios.post(NX_GRAPHQL_URL, { query, variables }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
      timeout: 15000,
    });
    res.json(data); // GraphQL response
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Token proxy running at http://localhost:${PORT}`));