// firebase/functions-issues/index.js
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

try { admin.app(); } catch { admin.initializeApp(); }
setGlobalOptions({ region: "asia-southeast1", memory: "512MiB", timeoutSeconds: 60 });

const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");

// libs
const { verifyLineIdToken } = require("./lib/line");
const { pickIssuePayload } = require("./lib/validate");
// triggers
const { onIssuePhotoUploaded } = require("./triggers/onIssuePhotoUploaded");

/* ===================== CORS ===================== */
// อนุญาต localhost (dev), และทุก *.vercel.app (ทั้ง preview/prod บน Vercel)
// ถ้ามีโดเมนจริงของคุณ (เช่น survey.yourbrand.com) ให้เพิ่ม regex ใหม่เข้าไปตามตัวอย่างคอมเมนต์
const ALLOWED = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i,
  // ตัวอย่าง: เพิ่มโดเมนโปรดักชันของคุณ (เปลี่ยน yourbrand เป็นของจริง)
  // /^https:\/\/survey\.yourbrand\.com$/i,
];

// เปิดกว้างชั่วคราวตอนดีบัก (อย่าลืมปิดในโปรดักชัน)
const DEV_ALLOW_ALL = false;

function isAllowedOrigin(origin = "") {
  try {
    const u = new URL(origin);
    // Origin ที่เบราว์เซอร์ส่งมา "ไม่มี / ท้าย" เสมอ -> ใช้ protocol//host
    const o = `${u.protocol}//${u.host}`;
    return ALLOWED.some(re => re.test(o));
  } catch { return false; }
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = DEV_ALLOW_ALL || isAllowedOrigin(origin);

  // เฮดเดอร์พื้นฐานที่ต้องมี
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Max-Age", "86400"); // cache preflight 24 ชม.

  if (req.method === "OPTIONS") {
    // ต้องใส่เฮดเดอร์ด้านบนก่อนเสมอ แล้วตอบ 204 เพื่อให้ preflight ผ่าน
    res.status(204).send("");
    return true;
  }
  if (!allowed) {
    console.warn("CORS blocked for origin:", origin);
    res.status(403).send("CORS blocked");
    return true;
  }
  return false;
}
/* ===================== จบ CORS ===================== */

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
    console.error("authLine.error", e?.message || e);
    return res.status(401).send("Unauthorized");
  }
});

/** POST /createIssue -> สร้างเอกสารตามสคีม่า + คืน prefix สำหรับอัปโหลดรูป */
exports.createIssue = onRequest({ secrets: [LINE_CHANNEL_ID] }, async (req, res) => {
  if (applyCors(req, res)) return;
  const t0 = Date.now();
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Verify LINE id_token จาก header Authorization: Bearer <IDTOKEN>
    const idToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!idToken) { console.warn("createIssue: missing Authorization"); return res.status(401).send("Missing Authorization"); }
    const profile = await verifyLineIdToken(idToken, LINE_CHANNEL_ID.value());
    const uid = `line_${profile.sub}`;

    // ตรวจและจัด payload ให้ตรงสคีม่า
    const b = pickIssuePayload(req.body || {});
    console.log("createIssue.start", { uid, farmId: b.farmId, plotId: b.plotId, category: b.category });

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

// Storage trigger ทำ thumbnail + เขียน photos[]
exports.onIssuePhotoUploaded = onIssuePhotoUploaded({ admin });

// ping เอาไว้เทส URL
exports.ping = onRequest((req, res) => {
  if (applyCors(req, res)) return;
  res.json({ ok: true, codebase: "issues", at: new Date().toISOString() });
});
