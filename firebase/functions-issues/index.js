// functions-issues/index.js
// Node 20 / Gen2 / CommonJS

const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");

// ---------- Firebase Admin ----------
try { admin.app(); } catch { admin.initializeApp(); }

setGlobalOptions({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
});

// ---------- CORS helpers ----------
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  // ถ้ามีโดเมนอื่นให้เพิ่มที่นี่ (ห้ามมี / ท้าย)
]);

function setCors(req, res) {
  const origin = req.header("Origin");
  res.set("Vary", "Origin");
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "3600");
  }
}

function endJson(res, code, obj) {
  res.set("Content-Type", "application/json; charset=utf-8");
  return res.status(code).json(obj);
}

// ---------- Utils ----------
function jsonBody(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    return {};
  }
}

async function verifyFirebaseIdTokenFromHeader(req, res) {
  const authz = req.header("Authorization") || "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    endJson(res, 401, { ok: false, error: "UNAUTHENTICATED", message: "Missing Authorization: Bearer <FirebaseIdToken>" });
    return null;
  }
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    endJson(res, 401, { ok: false, error: "UNAUTHENTICATED", message: "Invalid Firebase ID token" });
    return null;
  }
}

function sanitizeAuditAnswers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => ({
    sectionId: Number(x?.sectionId) || null,
    sectionTitle: x?.sectionTitle ?? null,
    itemNo: x?.itemNo ?? null,
    text: x?.text ?? null,
    result: (x?.result === "PASS" || x?.result === "FAIL") ? x.result : null,
  }));
}

// ---------- authLine: LINE id_token -> Firebase custom token ----------
const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");

exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  try {
    const body = jsonBody(req);
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
      console.error("[authLine] createCustomToken error", e);
      return endJson(res, 500, { ok:false, error:"CUSTOM_TOKEN_SIGN_ERROR", message: e?.message || String(e) });
    }

  } catch (e) {
    console.error("[authLine] INTERNAL_ERROR", e);
    return endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

// ---------- createIssue: เก็บฟอร์ม 2 ช้อยส์ (data-only) ----------
const CATEGORY_ALLOWED = new Set(["OTHER","GENERAL","ISSUE","WATER","EQUIPMENT","PEST","GAQP"]);

exports.createIssue = onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  // ใช้ Firebase ID token (ไม่ใช่ LINE id_token)
  const decoded = await verifyFirebaseIdTokenFromHeader(req, res);
  if (!decoded) return; // ได้ตอบ 401 ไปแล้ว

  try {
    const b = jsonBody(req);

    const farmId = b.farmId ?? null;
    const plotId = b.plotId ?? null;
    const severity = Number(b.severity) || 1;
    const description = b.description ?? "GAqP self-audit (data-only)";
    const consent = Boolean(b.consent);
    const auditAnswers = sanitizeAuditAnswers(b.auditAnswers);

    let category = b.category ?? "OTHER";
    if (!CATEGORY_ALLOWED.has(category)) category = "OTHER";

    const doc = {
      farmId,
      plotId,
      category,
      description,
      consent,
      auditAnswers,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: {
        uid: decoded.uid || null,
        name: decoded.name || null,
        picture: decoded.picture || null,
        provider: decoded.firebase?.sign_in_provider || null,
      },
      status: "OPEN",
    };

    const ref = await admin.firestore().collection("farm_issues").add(doc);
    return endJson(res, 200, { ok:true, issueId: ref.id });

  } catch (e) {
    console.error("[createIssue] error", e);
    return endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

// ---------- diagWhoamiIssues: เช็ค CORS/Auth/Origin ----------
exports.diagWhoamiIssues = onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  let decoded = null;
  const authz = req.header("Authorization") || "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    try { decoded = await admin.auth().verifyIdToken(m[1]); } catch {}
  }
  return endJson(res, 200, {
    ok: true,
    origin: req.header("Origin") || null,
    allow: ALLOW_ORIGINS.has(req.header("Origin") || "") ? "allowed" : "not-allowed",
    hasAuthHeader: Boolean(m),
    uid: decoded?.uid || null,
    provider: decoded?.firebase?.sign_in_provider || null,
  });
});
