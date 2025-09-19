// functions-issues/index.js
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
try { admin.app(); } catch { admin.initializeApp(); }

setGlobalOptions({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
});

// ---------- CORS (allowlist แบบเป๊ะ) ----------
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  // เพิ่มโดเมนอื่นของคุณที่ต้องอนุญาตได้ที่นี่
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

function sanitizeAuditAnswers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => ({
    sectionId: Number(x?.sectionId) || null,
    sectionTitle: (x?.sectionTitle ?? null),
    itemNo: (x?.itemNo ?? null),
    text: (x?.text ?? null),
    result: (x?.result === "PASS" || x?.result === "FAIL") ? x.result : null
  }));
}

const CATEGORY_ALLOWED = new Set(["OTHER","GENERAL","ISSUE","WATER","EQUIPMENT","PEST","GAQP"]);

exports.createIssue = onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  try {
    // ---- Auth: Firebase ID token ----
    const authz = req.header("Authorization") || "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) return endJson(res, 401, { ok:false, error:"UNAUTHENTICATED", message:"Missing bearer token" });
    const idToken = m[1];
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return endJson(res, 401, { ok:false, error:"UNAUTHENTICATED", message:"Invalid Firebase ID token" });
    }

    // ---- Body ----
    const b = (typeof req.body === "string") ? JSON.parse(req.body || "{}") : (req.body || {});
    const farmId = (b.farmId ?? null);
    const plotId = (b.plotId ?? null);
    const severity = Number(b.severity) || 1;
    const description = (b.description ?? null);
    const consent = Boolean(b.consent);
    const auditAnswers = sanitizeAuditAnswers(b.auditAnswers);

    // category: default OTHER หากไม่ส่งมา หรือไม่อยู่ใน allowlist
    let category = (b.category ?? "OTHER");
    if (!CATEGORY_ALLOWED.has(category)) category = "OTHER";

    // ---- สร้างเอกสาร ----
    const now = admin.firestore.FieldValue.serverTimestamp();
    const doc = {
      farmId,
      plotId,
      category,
      severity,
      description,
      geo: b.geo ?? null,
      consent,
      auditAnswers,
      createdAt: now,
      createdBy: {
        uid: decoded.uid || null,
        name: decoded.name || null,
        picture: decoded.picture || null,
        provider: decoded.firebase?.sign_in_provider || null
      },
      status: "OPEN"
    };

    const ref = await admin.firestore().collection("farm_issues").add(doc);

    return endJson(res, 200, { ok:true, issueId: ref.id });

  } catch (err) {
    return endJson(res, 500, {
      ok:false,
      error:"INTERNAL_ERROR",
      message: err?.message || String(err),
      code: "FUNCTION_INVOCATION_FAILED"
    });
  }
});
