// firebase/functions-issues/lib/line.js
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

async function verifyLineIdToken(idToken, channelIdRaw) {
  const channelId = String(channelIdRaw ?? "").trim(); // << สำคัญ: ตัดช่องว่าง
  const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });

  const data = await resp.json().catch(() => ({}));
  const ok = resp.ok && data?.sub && (data?.aud === channelId || data?.client_id === channelId);
  if (!ok) {
    // โยนรายละเอียดเพื่ออ่านใน Logs และส่งกลับหน้าเว็บตอน 401
    throw new Error(`LINE verify failed (${resp.status}) cid=${channelId} : ${JSON.stringify(data)}`);
  }
  return data; // { sub, aud, name?, picture?, ... }
}

module.exports = { verifyLineIdToken };
