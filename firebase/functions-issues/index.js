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
const ORIGIN_RULES = [
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  "https://liff-test-finh-tracking.vercel.app",
  // preview URLs ของทั้งสองโปรเจกต์บน Vercel
  /^https:\/\/liff-test-finh-[a-z0-9-]+\.vercel\.app$/i,
  /^https:\/\/liff-test-finh-tracking-[a-z0-9-]+\.vercel\.app$/i,
];

function isAllowedOrigin(origin) {
  return ORIGIN_RULES.some(r => typeof r === "string" ? r === origin : r.test(origin));
}

function setCors(req, res) {
  const origin = req.header("Origin") || "";
  res.set("Vary", "Origin");
  if (origin && isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    // echo กลับ headers ที่ browser ขอมา ป้องกันกรณี browser ขอ header แปลกๆ
    const reqHdr = req.header("Access-Control-Request-Headers");
    res.set("Access-Control-Allow-Headers", reqHdr || "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
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
// เพิ่มที่ส่วน defineSecret เดิม
const LINE_CHANNEL_ID  = defineSecret("LINE_CHANNEL_ID");   // เดิม: single
const LINE_CHANNEL_IDS = defineSecret("LINE_CHANNEL_IDS");  // ใหม่: หลายค่า (comma/space แยก)

// helper: decode JWT payload เพื่อดึง aud (Channel ID) มาดู
function decodeJwtNoVerify(token) {
  try {
    const [, payload] = (token || "").split(".");
    if (!payload) return {};
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json);
  } catch { return {}; }
}

exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID, LINE_CHANNEL_IDS] }, async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  try {
    const body = jsonBody(req);
    const idToken = body.idToken;
    if (!idToken) return endJson(res, 400, { ok:false, error:"MISSING_ID_TOKEN" });

    // รายการ clientIds ที่อนุญาต จาก secrets
    const raw = (LINE_CHANNEL_IDS.value?.() || LINE_CHANNEL_ID.value?.() || "").trim();
    const allowed = raw.split(/[,\s]+/).filter(Boolean); // ["2008118596","2008142684", ...]
    if (allowed.length === 0) {
      console.error("[authLine] Missing secret LINE_CHANNEL_ID(S)");
      return endJson(res, 500, { ok:false, error:"MISSING_SECRET" });
    }

    // อ่าน aud จาก id_token (เลข Channel ID ที่ token ผูกมา)
    const decoded = decodeJwtNoVerify(idToken);
    const aud = decoded?.aud ? String(decoded.aud) : null;

    // ถ้า aud มี และไม่อยู่ใน allowed → ปัดตกชัดเจน จะได้รู้ว่าใส่ secret ผิด
    if (aud && !allowed.includes(aud)) {
      console.error("[authLine] AUD_NOT_ALLOWED", { aud, allowed });
      return endJson(res, 401, { ok:false, error:"AUD_NOT_ALLOWED", aud, message:"This id_token belongs to a different Channel ID (aud) than your allowed list." });
    }

    // สร้าง candidate รายการที่จะลอง verify (ให้ลอง aud ก่อน เพื่อผ่านชัวร์)
    const candidates = [];
    if (aud && allowed.includes(aud)) candidates.push(aud);
    // ตามด้วยรายการ allowed อื่น ๆ ที่ยังไม่ได้ลอง
    for (const cid of allowed) if (!candidates.includes(cid)) candidates.push(cid);

    // 1) Verify กับ LINE: ไล่ทีละ client_id
    let verified = null, lastDetail = null, lastStatus = 0, usedCid = null;
    for (const cid of candidates) {
      try {
        const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
          method: "POST",
          headers: { "Content-Type":"application/x-www-form-urlencoded" },
          body: new URLSearchParams({ id_token: idToken, client_id: cid }).toString(),
        });
        lastStatus = resp.status;
        const js = await resp.json().catch(()=> ({}));
        if (resp.ok && js?.sub) { verified = js; usedCid = cid; break; }
        lastDetail = js;
      } catch (e) {
        lastDetail = { error: String(e?.message || e) };
      }
    }
    if (!verified) {
      console.error("[authLine] LINE verify failed", { lastStatus, lastDetail, aud, candidates });
      return endJson(res, 401, { ok:false, error:"INVALID_LINE_ID_TOKEN", status:lastStatus, detail:lastDetail, aud, tried:candidates });
    }

    // 2) สร้าง custom token
    const uid = `line_${verified.sub}`;
    try {
      const customToken = await admin.auth().createCustomToken(uid, {
        name: verified.name || null,
        picture: verified.picture || null,
        email: verified.email || null,
        provider: "line",
      });
      console.log("[authLine] verified with client_id", usedCid);
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
  const origin = req.header("Origin") || null;
  return endJson(res, 200, {
    ok: true,
    origin,
    allow: origin && isAllowedOrigin(origin) ? "allowed" : "not-allowed",
    hasAuthHeader: Boolean(m),
    uid: decoded?.uid || null,
    provider: decoded?.firebase?.sign_in_provider || null,
  });
});
