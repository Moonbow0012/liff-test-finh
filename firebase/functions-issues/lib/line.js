// lib/line.js
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

async function verifyLineIdToken(idToken, channelId) {
  const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });

  const data = await resp.json().catch(() => ({}));

  // คาดหวังให้มี sub และ aud = channelId
  const ok = resp.ok && data?.sub && (data?.aud === channelId || data?.client_id === channelId);
  if (!ok) {
    // โยนรายละเอียดให้อ่านใน Cloud Logging ได้ชัด
    const msg = `LINE verify failed (${resp.status}): ` + JSON.stringify(data);
    throw new Error(msg);
  }
  return data; // { sub, aud, name?, picture?, ... }
}

module.exports = { verifyLineIdToken };
