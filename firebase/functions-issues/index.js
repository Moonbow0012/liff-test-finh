const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");

try { admin.app(); } catch { admin.initializeApp(); }
setGlobalOptions({ region: "asia-southeast1", memory: "256MiB", timeoutSeconds: 60 });

/* CORS (allowlist ให้ตรงโดเมนจริง, ไม่มี / ท้าย) */
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
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

const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");

exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const idToken = body.idToken;
    if (!idToken) return endJson(res, 400, { ok:false, error:"MISSING_ID_TOKEN", message:"no idToken in body" });

    const clientId = LINE_CHANNEL_ID.value?.();
    if (!clientId) {
      console.error("[authLine] Missing secret LINE_CHANNEL_ID");
      return endJson(res, 500, { ok:false, error:"MISSING_SECRET", message:"LINE_CHANNEL_ID is empty" });
    }

    // 1) Verify กับ LINE
    let verifyStatus = -1, verifyJson = null;
    try {
      const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id_token: idToken, client_id: clientId }).toString(),
      });
      verifyStatus = resp.status;
      verifyJson = await resp.json().catch(()=> ({}));
      if (!resp.ok || !verifyJson?.sub) {
        console.error("[authLine] LINE verify failed", { status: verifyStatus, detail: verifyJson });
        return endJson(res, 401, { ok:false, error:"INVALID_LINE_ID_TOKEN", message:"LINE verify failed", detail: verifyJson, status: verifyStatus });
      }
    } catch (e) {
      console.error("[authLine] LINE verify error", e);
      return endJson(res, 502, { ok:false, error:"LINE_VERIFY_NETWORK_ERROR", message: e?.message || String(e) });
    }

    // 2) สร้าง custom token
    const uid = `line_${verifyJson.sub}`;
    try {
      const customToken = await admin.auth().createCustomToken(uid, {
        name: verifyJson.name || null,
        picture: verifyJson.picture || null,
        email: verifyJson.email || null,
        provider: "line",
      });
      return endJson(res, 200, { ok:true, firebaseToken: customToken });
    } catch (e) {
      // เคสพบบ่อย: signBlob denied → ต้องให้สิทธิ์ Service Account Token Creator แก่ appspot SA
      console.error("[authLine] createCustomToken error", e);
      return endJson(res, 500, { ok:false, error:"CUSTOM_TOKEN_SIGN_ERROR", message: e?.message || String(e) });
    }

  } catch (e) {
    console.error("[authLine] INTERNAL_ERROR", e);
    return endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});
