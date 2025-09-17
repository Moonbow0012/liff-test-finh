// firebase/functions-issues/index.js
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

async function getRuntimeServiceAccountEmail() {
  try {
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
      { headers: { "Metadata-Flavor": "Google" } }
    );
    return await r.text();
  } catch { return null; }
}

try { admin.app(); } catch { admin.initializeApp(); }

const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "finh-iot-ai";

setGlobalOptions({
  region: "asia-southeast1",
  memory: "512MiB",
  timeoutSeconds: 60,
  // บังคับให้รันด้วย App Engine default service account
  serviceAccount: `${PROJECT_ID}@appspot.gserviceaccount.com`,
});

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
  // เพิ่มโดเมนโปรดักชัน:
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
exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
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

    // STEP 2: ensure user
    try {
      await admin.auth().getUser(uid);
    } catch (e) {
      if (e && e.code === "auth/user-not-found") {
        try {
          await admin.auth().createUser({ uid, displayName: profile.name || "LINE User" });
        } catch (e2) {
          console.error("authLine.createUser", e2?.message || e2);
          return res.status(500).json({ ok:false, where:"authLine/createUser", error:String(e2?.message || e2) });
        }
      } else {
        console.error("authLine.getUser", e?.message || e);
        return res.status(500).json({ ok:false, where:"authLine/getUser", error:String(e?.message || e) });
      }
    }

    // STEP 3: issue custom token
    try {
      const firebaseToken = await admin.auth().createCustomToken(uid, { lineSub: profile.sub });
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

    // STEP 3: write
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

exports.diagWhoami = onRequest(async (req, res) => {
  const sa = await getRuntimeServiceAccountEmail();
  res.json({
    projectId_env: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
    runtimeServiceAccount: sa,
  });
});

// ---------- /ping ----------
exports.ping = onRequest((req, res) => {
  if (applyCors(req, res)) return;
  res.json({ ok:true, codebase:"issues", at:new Date().toISOString() });
});

exports.diagWhoami = onRequest(async (req, res) => {
  res.json({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
    runtimeServiceAccount: await getRuntimeServiceAccountEmail(),
  });
});