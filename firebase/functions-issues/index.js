// functions-issues/index.js
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");

try { admin.app(); } catch { admin.initializeApp(); }

setGlobalOptions({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
});

/* ---------------- CORS helpers (ใช้ร่วมทุก endpoint) ---------------- */
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  // เพิ่ม origin อื่นได้ที่นี่ (ใส่ให้เป๊ะ ไม่มี / ท้าย)
]);

function setCors(req, res) {
  const origin = req.header("Origin");
  res.set("Vary", "Origin");
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "3600");
  }
}
function endJson(res, code, obj) {
  res.set("Content-Type", "application/json; charset=utf-8");
  return res.status(code).json(obj);
}

/* ---------------- Secrets ---------------- */
const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");

/* ---------------- authLine: verify LINE id_token -> Firebase custom token ---------------- */
exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const idToken = body.idToken;
    if (!idToken) return endJson(res, 400, { ok:false, error:"MISSING_ID_TOKEN" });

    // เรียก LINE verify เพื่อตรวจ id_token
    // doc: https://developers.line.biz/en/reference/line-login/#verify-id-token
    const verifyUrl = "https://api.line.me/oauth2/v2.1/verify";
    const params = new URLSearchParams({
      id_token: idToken,
      client_id: LINE_CHANNEL_ID.value(), // ใส่ Channel ID ของคุณ
    });

    const r = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const v = await r.json().catch(()=> ({}));
    if (!r.ok || !v || !v.sub) {
      return endJson(res, 401, { ok:false, error:"INVALID_LINE_ID_TOKEN", detail: v });
    }

    const uid = `line_${v.sub}`; // กำหนดรูปแบบ uid
    // (ออปชัน) ใส่ข้อมูลเสริมบน custom token ได้ เช่น { name: v.name, picture: v.picture }
    const customToken = await admin.auth().createCustomToken(uid, {
      name: v.name || null,
      picture: v.picture || null,
      email: v.email || null,
      provider: "line",
    });

    return endJson(res, 200, {
      ok: true,
      firebaseToken: customToken,
      line: { sub: v.sub, name: v.name || null, picture: v.picture || null, email: v.email || null }
    });

  } catch (err) {
    return endJson(res, 500, {
      ok:false,
      error:"INTERNAL_ERROR",
      message: err?.message || String(err),
      code: "FUNCTION_INVOCATION_FAILED"
    });
  }
});

/* ------------------ (ถ้ามีอยู่แล้ว ให้คง createIssue ของคุณไว้ด้านล่าง) ------------------ */
// exports.createIssue = onRequest(... เดิมของคุณ ...);
