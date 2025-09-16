const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

try { admin.app(); } catch { admin.initializeApp(); }
setGlobalOptions({ region: "asia-southeast1", memory: "512MiB", timeoutSeconds: 60 });

const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID"); // ตั้ง secret ด้วย CLI ก่อน deploy

// libs
const { verifyLineIdToken } = require("./lib/line");
const { pickIssuePayload } = require("./lib/validate");
// triggers
const { onIssuePhotoUploaded } = require("./triggers/onIssuePhotoUploaded");

// CORS allowlist
const ALLOWED = new Set([
  "http://localhost:3000",
  "https://liff-test-finh.vercel.app",  // เปลี่ยนเป็นโดเมนจริงของคุณ
  "https://liff-test-finh-n8ql.vercel.app/" // preview domain
]);

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  return false;
}

/** POST /authLine -> แลก LINE id_token เป็น Firebase custom token */
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
    console.error(e);
    return res.status(401).send("Unauthorized");
  }
});

/** POST /createIssue -> สร้างเอกสารตามสคีม่า + คืน prefix สำหรับอัปโหลดรูป */
exports.createIssue = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Verify LINE id_token จาก header Authorization: Bearer <IDTOKEN>
    const idToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!idToken) return res.status(401).send("Missing Authorization");
    const profile = await verifyLineIdToken(idToken, LINE_CHANNEL_ID.value());
    const uid = `line_${profile.sub}`;

    // ตรวจและจัด payload ให้ตรงสคีม่า
    const b = pickIssuePayload(req.body || {});

    // สร้าง doc
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

    return res.json({
      issueId,
      uploadPrefix: `issues/${b.farmId}/${issueId}`,
      storageBucket: admin.app().options.storageBucket
    });
  } catch (e) {
    console.error(e);
    return res.status(400).send(e.message || "Bad Request");
  }
});

// Storage trigger ทำ thumbnail + เขียน photos[]
exports.onIssuePhotoUploaded = onIssuePhotoUploaded({ admin });

exports.ping = onRequest((req, res) => {
  if (applyCors(req, res)) return;
  res.json({ ok: true, codebase: "issues", at: new Date().toISOString() });
});