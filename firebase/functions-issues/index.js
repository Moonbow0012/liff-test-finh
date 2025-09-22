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

function getAllowedClientIds() {
  const combo = (LINE_CHANNEL_IDS.value?.() || "") + " " + (LINE_CHANNEL_ID.value?.() || "");
  return combo.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

// decode JWT เฉพาะเพื่ออ่าน aud (ไม่ใช่การ verify)
function decodeJwtNoVerify(token) {
  try {
    const [, payload] = String(token||"").split(".");
    return JSON.parse(Buffer.from(payload || "", "base64").toString("utf8"));
  } catch { return {}; }
}

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
    const { idToken, accessToken } = jsonBody(req);
    if (!idToken && !accessToken) {
      return endJson(res, 400, { ok:false, error:"MISSING_TOKEN", message:"need idToken or accessToken" });
    }

    const allowed = getAllowedClientIds();               // ✅ มีเสมอ
    if (!allowed.length) {
      return endJson(res, 500, { ok:false, error:"MISSING_SECRET", message:"No Channel IDs in LINE_CHANNEL_IDS/LINE_CHANNEL_ID" });
    }

    let sub = null, profile = {}, usedClientId = null, aud = null, lastDetail = null, lastStatus = 0;

    // ---- Path A: verify id_token ด้วย client_id ที่อนุญาต
    if (idToken) {
      aud = String(decodeJwtNoVerify(idToken)?.aud || "");
      const candidates = (aud && allowed.includes(aud))
        ? [aud, ...allowed.filter(x => x !== aud)]
        : [...allowed];

      for (const cid of candidates) {
        try {
          const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ id_token: idToken, client_id: cid }).toString(),
          });
          lastStatus = resp.status;
          const js = await resp.json().catch(()=> ({}));
          if (resp.ok && js?.sub) {
            sub = js.sub;
            profile = { name: js.name || null, picture: js.picture || null, email: js.email || null };
            usedClientId = cid;
            break;
          }
          lastDetail = js;
        } catch (e) {
          lastDetail = { error: String(e?.message || e) };
        }
      }

      // id_token ผูกกับ channel อื่นที่เราไม่ได้อนุญาต
      if (!sub && aud && !allowed.includes(aud)) {
        return endJson(res, 401, { ok:false, error:"AUD_NOT_ALLOWED", aud, allowed });
      }
    }

    // ---- Path B: fallback ด้วย access_token → verify + userinfo
    if (!sub && accessToken) {
      try {
        // 1) ตรวจ client_id จาก access token
        const vr = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
        const vj = await vr.json().catch(()=> ({}));
        if (!vr.ok || !vj?.client_id) {
          return endJson(res, 401, { ok:false, error:"ACCESS_TOKEN_VERIFY_FAILED", detail: vj });
        }
        if (!allowed.includes(String(vj.client_id))) {
          return endJson(res, 401, { ok:false, error:"CLIENT_ID_NOT_ALLOWED", client_id: vj.client_id, allowed });
        }
        usedClientId = String(vj.client_id);

        // 2) ดึง userinfo เพื่อหา sub
        const ur = await fetch("https://api.line.me/oauth2/v2.1/userinfo", {
          headers: { "Authorization": "Bearer " + accessToken }
        });
        const uj = await ur.json().catch(()=> ({}));
        if (!ur.ok || !uj?.sub) {
          return endJson(res, 401, { ok:false, error:"USERINFO_FAILED", detail: uj });
        }
        sub = uj.sub;
        profile = { name: uj.name || null, picture: uj.picture || null, email: uj.email || null };
      } catch (e) {
        return endJson(res, 502, { ok:false, error:"LINE_NETWORK_ERROR", message: String(e?.message || e) });
      }
    }

    // ยังยืนยันไม่ได้ทั้งสองทาง
    if (!sub) {
      return endJson(res, 401, {
        ok:false,
        error:"INVALID_LINE_ID_TOKEN",
        status:lastStatus,
        detail:lastDetail,
        aud,
        tried: allowed,           // ✅ allowed อยู่ในสโคปนี้แล้ว
      });
    }

    // ---- ออก Firebase custom token
    const uid = `line_${sub}`;
    try {
      const customToken = await admin.auth().createCustomToken(uid, {
        name: profile.name,
        picture: profile.picture,
        email: profile.email,
        provider: "line",
      });
      console.log("[authLine] verified via", usedClientId ? `client_id:${usedClientId}` : "userinfo");
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
