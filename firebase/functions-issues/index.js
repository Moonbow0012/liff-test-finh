const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

try { admin.app(); } catch { admin.initializeApp(); }
setGlobalOptions({ region: "asia-southeast1", memory: "512MiB", timeoutSeconds: 60 });

const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");

const { verifyLineIdToken } = require("./lib/line");
const { pickIssuePayload } = require("./lib/validate");
const { onIssuePhotoUploaded } = require("./triggers/onIssuePhotoUploaded");

/* ===== CORS: localhost + ทุก *.vercel.app (+เพิ่มโดเมนจริงได้) ===== */
const ALLOWED = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i,
  // ตัวอย่าง: เพิ่มโดเมนโปรดักชันของคุณ
  // /^https:\/\/survey\.yourbrand\.com$/i,
];
const DEV_ALLOW_ALL = false;

function isAllowedOrigin(origin = "") {
  try {
    const u = new URL(origin);
    const o = `${u.protocol}//${u.host}`; // ไม่มี / ท้าย
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
  if (!hasOrigin) return false; // เปิด ping ผ่านเบราเซอร์ได้
  if (!allowed) { console.warn("CORS blocked for origin:", origin); res.status(403).send("CORS blocked"); return true; }
  return false;
}
/* ================================ */

exports.authLine = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).send("Missing idToken");

    const profile = await verifyLineIdToken(idToken, LINE_CHANNEL_ID.value());
    const uid = `line_${profile.sub}`;

    await admin.auth().getUser(uid).catch(() =>
      admin.auth().createUser({ uid, displayName: profile.name || "LINE User" })
    );
    const firebaseToken = await admin.auth().createCustomToken(uid, { lineSub: profile.sub });

    return res.json({ firebaseToken, displayName: profile.name || null });
  } catch (e) {
    console.error("authLine.error", e?.message || e);
    // ส่งรายละเอียดกลับไป (ช่วง debug) เพื่อจะได้เห็นว่า verify พลาดอะไร
    return res.status(401).json({ ok: false, error: String(e?.message || e) });
  }
});

exports.createIssue = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  if (applyCors(req, res)) return;
  const t0 = Date.now();
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const idToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!idToken) { console.warn("createIssue: missing Authorization"); return res.status(401).send("Missing Authorization"); }

    const profile = await verifyLineIdToken(idToken, LINE_CHANNEL_ID.value());
    const uid = `line_${profile.sub}`;

    const b = pickIssuePayload(req.body || {});
    console.log("createIssue.start", { uid, farmId: b.farmId, plotId: b.plotId, category: b.category });

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
    const issueId = ref.id;

    console.log("createIssue.done", { issueId, ms: Date.now() - t0 });
    return res.json({
      issueId,
      uploadPrefix: `issues/${b.farmId}/${issueId}`,
      storageBucket: admin.app().options.storageBucket
    });
  } catch (e) {
    console.error("createIssue.error", e?.message || e);
    return res.status(400).send(e.message || "Bad Request");
  }
});

exports.onIssuePhotoUploaded = onIssuePhotoUploaded({ admin });

exports.ping = onRequest((req, res) => {
  if (applyCors(req, res)) return;
  res.json({ ok: true, codebase: "issues", at: new Date().toISOString() });
});
