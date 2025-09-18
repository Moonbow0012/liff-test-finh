// firebase/functions-issues/index.js
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

// ====== CONFIG ======
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "finh-iot-ai";
const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID"); // 2008118596
const SA_KEY_JSON = defineSecret("SA_KEY_JSON");         // วางเนื้อไฟล์ key JSON ทั้งก้อน

// Functions tuning
setGlobalOptions({
  region: "asia-southeast1",
  memory: "512MiB",
  timeoutSeconds: 60,
});

// ====== Default app สำหรับ Firestore/Storage/Triggers (ADC ปกติ) ======
try { admin.app(); } catch { admin.initializeApp(); }

// ====== แอปพิเศษสำหรับ Auth (ใช้ key JSON; ไม่พึ่ง signBlob) ======
let authApp = null;

function sanitizeSaJsonRaw(raw) {
  let s = String(raw ?? "");
  // ตัด BOM
  s = s.replace(/^\uFEFF/, "").trim();

  // ถ้าเผลอใส่เป็น ```json ... ```
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // ถ้าเผลอครอบด้วย "…"
  if (s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s); } catch (_) {}
  }
  return s;
}

function parseSaKeyOrThrow(raw) {
  const s = sanitizeSaJsonRaw(raw);
  if (!s || !s.trim().startsWith("{")) {
    throw new Error("SA_KEY_JSON is missing or not raw JSON (must start with '{').");
  }
  let obj;
  try { obj = JSON.parse(s); }
  catch (e) { throw new Error("SA_KEY_JSON parse error: " + e.message); }

  if (!obj.client_email || !obj.private_key || !obj.project_id) {
    throw new Error("SA_KEY_JSON missing required fields (client_email/private_key/project_id).");
  }
  // ตรวจรูปแบบ private_key (ควรมี \n ไม่ใช่บรรทัดจริง)
  const pk = String(obj.private_key);
  const hasEscapedNL = pk.includes("\\n");
  const hasRealNL = /\n/.test(pk);
  if (!hasEscapedNL && hasRealNL) {
    // มีบรรทัดจริงแต่ไม่มี \n → ส่วนใหญ่เกิดจากพังตอน paste
    throw new Error("SA_KEY_JSON.private_key appears to contain real newlines; it must contain \\n escapes.");
  }
  return obj;
}

function ensureAuthApp() {
  if (authApp) return authApp;
  const keyObj = parseSaKeyOrThrow(SA_KEY_JSON.value());      // <= ฟ้อง error ชัด
  authApp = admin.initializeApp({ credential: admin.credential.cert(keyObj) }, "authapp");
  return authApp;
}

// ---- utils: verify with LINE + peek aud from JWT (debug) ----
function peekAud(idToken) {
  try {
    const part = idToken.split(".")[1];
    const json = Buffer.from(part, "base64").toString("utf8");
    return JSON.parse(json)?.aud || null;
  } catch { return null; }
}

async function verifyWithLine(idToken, channelIdRaw) {
  const channelId = String(channelIdRaw || "").trim();
  const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });
  const body = await r.json().catch(() => ({}));
  const ok = r.ok && body?.sub && (body?.aud === channelId || body?.client_id === channelId);
  if (!ok) {
    const msg = `LINE verify failed (${r.status}) cid=${channelId} : ${JSON.stringify(body)}`;
    throw new Error(msg);
  }
  return body; // { sub, aud, name?, picture?, exp, ... }
}

/* ===== CORS ===== */
const ALLOWED = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i,
  // เพิ่มโดเมนโปรดักชันของคุณ:
  // /^https:\/\/survey\.yourbrand\.com$/i,
];
const DEV_ALLOW_ALL = false;

function isAllowedOrigin(origin = "") {
  try {
    const u = new URL(origin);
    const o = `${u.protocol}//${u.host}`;
    return ALLOWED.some(re => re.test(o));
  } catch { return false; }
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const hasOrigin = !!origin;
  const allowed = DEV_ALLOW_ALL || (hasOrigin && isAllowedOrigin(origin));

  if (allowed) res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  if (!hasOrigin) return false;
  if (!allowed) { console.warn("CORS blocked for origin:", origin); res.status(403).send("CORS blocked"); return true; }
  return false;
}
/* ================= */

// ---------- /authLine ----------
exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID, SA_KEY_JSON] }, async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const channelId = (LINE_CHANNEL_ID.value() || "").trim();
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ ok:false, where:"authLine/parse", error:"Missing idToken" });

    // STEP 1: verify กับ LINE
    let profile;
    try {
      profile = await verifyWithLine(idToken, channelId);
    } catch (e) {
      console.error("authLine.verify", e?.message || e);
      return res.status(401).json({
        ok:false,
        where:"authLine/verify",
        error:String(e?.message || e),
        audFromToken: peekAud(idToken)
      });
    }

    const uid = `line_${profile.sub}`;

    // ใช้ authApp (cert) สำหรับ Auth ทั้งหมด (ไม่พึ่ง signBlob)
    let auth;
    try {
      auth = ensureAuthApp().auth();
    } catch (e) {
      console.error("authLine.ensureAuthApp", e?.message || e);
      return res.status(500).json({ ok:false, where:"authLine/ensureAuthApp", error:String(e?.message || e) });
    }

    // STEP 2: ensure user
    try {
      await auth.getUser(uid);
    } catch (e) {
      if (e && e.code === "auth/user-not-found") {
        try {
          await auth.createUser({ uid, displayName: profile.name || "LINE User" });
        } catch (e2) {
          console.error("authLine.createUser", e2?.message || e2);
          return res.status(500).json({ ok:false, where:"authLine/createUser", error:String(e2?.message || e2) });
        }
      } else {
        console.error("authLine.getUser", e?.message || e);
        return res.status(500).json({ ok:false, where:"authLine/getUser", error:String(e?.message || e) });
      }
    }

    // STEP 3: issue custom token (ลงลายเซ็นในเครื่อง)
    try {
      const firebaseToken = await auth.createCustomToken(uid, { lineSub: profile.sub });
      return res.json({ ok:true, firebaseToken, displayName: profile.name || null });
    } catch (e) {
      console.error("authLine.customToken", e?.message || e);
      return res.status(500).json({ ok:false, where:"authLine/customToken", error:String(e?.message || e) });
    }
  } catch (e) {
    console.error("authLine.unknown", e?.message || e);
    return res.status(500).json({ ok:false, where:"authLine/unknown", error:String(e?.message || e) });
  }
});

// ---------- /createIssue ----------
exports.createIssue = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const channelId = (LINE_CHANNEL_ID.value() || "").trim();
  const t0 = Date.now();

  try {
    const idToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!idToken) return res.status(401).json({ ok:false, where:"createIssue/auth", error:"Missing Authorization" });

    // STEP 1: verify
    let profile;
    try {
      profile = await verifyWithLine(idToken, channelId);
    } catch (e) {
      console.error("createIssue.verify", e?.message || e);
      return res.status(401).json({
        ok:false, where:"createIssue/verify",
        error:String(e?.message || e), audFromToken: peekAud(idToken)
      });
    }
    const uid = `line_${profile.sub}`;

    // STEP 2: validate
    let b;
    try {
      b = require("./lib/validate").pickIssuePayload(req.body || {});
    } catch (e) {
      return res.status(400).json({ ok:false, where:"createIssue/validate", error:String(e?.message || e) });
    }

    // STEP 3: write (ใช้ default app)
    try {
      const db = admin.firestore();
      const doc = {
        ...b,
        reporter: { uid, displayName: profile.name || null },
        status: "OPEN",
        photos: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: uid,
        reviewedAt: null, reviewedBy: null, revision: 0
      };
      const ref = await db.collection("farm_issues").add(doc);
      return res.json({
        ok:true,
        issueId: ref.id,
        uploadPrefix: `issues/${b.farmId}/${ref.id}`,
        storageBucket: admin.app().options.storageBucket,
        tookMs: Date.now() - t0
      });
    } catch (e) {
      console.error("createIssue.firestore", e?.message || e);
      return res.status(500).json({ ok:false, where:"createIssue/firestore", error:String(e?.message || e) });
    }
  } catch (e) {
    console.error("createIssue.unknown", e?.message || e);
    return res.status(500).json({ ok:false, where:"createIssue/unknown", error:String(e?.message || e) });
  }
});

// ---------- /diagVerify ----------
exports.diagVerify = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  try {
    const idToken = (req.body && req.body.idToken) || "";
    const channelId = (LINE_CHANNEL_ID.value() || "").trim();
    const body = await verifyWithLine(idToken, channelId);
    res.json({ usedClientId: channelId, body });
  } catch (e) {
    res.status(401).json({ ok:false, where:"diagVerify", error:String(e?.message || e) });
  }
});

// ---------- storage trigger ----------
const { onIssuePhotoUploaded } = require("./triggers/onIssuePhotoUploaded");
exports.onIssuePhotoUploaded = onIssuePhotoUploaded({ admin });

// ---------- /ping ----------
exports.ping = onRequest((req, res) => {
  if (applyCors(req, res)) return;
  res.json({ ok:true, codebase:"issues", at:new Date().toISOString() });
});

// ---------- /diagSaKey (ตรวจ secret แบบไม่เปิดเผยคีย์) ----------
exports.diagSaKey = onRequest({ secrets: [SA_KEY_JSON] }, async (req, res) => {
  try {
    const raw0 = SA_KEY_JSON.value() || "";
    // ไม่เปิดเผยเนื้อหา: ตรวจแค่รูปแบบอักขระต้นน้ำ
    const first16 = Array.from(raw0.slice(0, 16)).map(c => c.charCodeAt(0));
    // sanitize แบบเดียวกับตอนใช้งานจริง
    const sanitize = (s) => {
      s = s.replace(/^\uFEFF/, "").trim();            // ตัด BOM
      s = s.replace(/^```(?:json)?\s*/i, "")
           .replace(/```$/i, "").trim();              // ตัด ``` ```
      if (s.startsWith('"') && s.endsWith('"')) {
        try { s = JSON.parse(s); } catch {}
      }
      return s;
    };
    const s = sanitize(raw0);
    let parsed = null, parseError = null, info = {};
    try {
      parsed = JSON.parse(s);
      info = {
        has_client_email: !!parsed.client_email,
        has_project_id: !!parsed.project_id,
        private_key_len: parsed.private_key ? String(parsed.private_key).length : 0,
        private_key_has_escaped_n: parsed.private_key ? String(parsed.private_key).includes("\\n") : false,
        private_key_has_real_newline: parsed.private_key ? /\n/.test(String(parsed.private_key)) : false,
      };
    } catch (e) {
      parseError = e.message;
    }
    res.json({
      ok: !!parsed,
      startsWithLeftBrace: s.trim().startsWith("{"),
      rawFirst16CharCodes: first16,
      parseError,
      info
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

