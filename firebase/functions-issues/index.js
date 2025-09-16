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

/* ======================= CORS (เวอร์ชันแข็งแรง) ======================= */
/**
 * อนุญาต:
 *  - localhost (dev)
 *  - ทุกโดเมน *.vercel.app (ทั้ง preview/prod ของ Vercel)
 *  - (ออปชัน) โดเมนโปรดักชันของคุณเอง: เติม regex เพิ่มด้านล่าง
 *
 * ไม่ต้องกรอก preview URL ทีละอัน — แพทเทิร์น *.vercel.app ครอบหมด
 */
const ALLOWED = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i,
  // ตัวอย่าง: ถ้ามีโดเมนจริงของคุณ ให้เพิ่มบรรทัด regex ของโดเมนคุณเอง:
  // /^https:\/\/survey\.yourbrand\.com$/i,
];

// เปิดกว้างชั่วคราวตอนดีบัก (อย่าลืมปิดในโปรดักชัน)
const DEV_ALLOW_ALL = false;

/** ตัดสินใจว่า origin นี้อนุญาตไหม */
function isAllowedOrigin(origin = "") {
  try {
    const u = new URL(origin);
    const o = `${u.protocol}//${u.host}`; // origin ไม่มี "/" ท้าย
    return ALLOWED.some((re) => re.test(o));
  } catch {
    return false; // กรณีไม่มี/ผิดรูปแบบ origin
  }
}

/**
 * ใส่ CORS headers และตอบ preflight ให้ถูกต้อง
 * - ถ้าเป็น OPTIONS: ตอบ 204 พร้อม header ที่ต้องใช้
 * - ถ้าไม่มี Origin (เช่นพิมพ์ URL ตรงในเบราว์เซอร์): "ไม่บล็อก" ให้ผ่าน (เพื่อเช็ค URL/ping ได้)
 * - ถ้ามี Origin แต่ไม่อนุญาต: 403 "CORS blocked"
 */
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const hasOrigin = !!origin;
  const allowed = DEV_ALLOW_ALL || (hasOrigin && isAllowedOrigin(origin));

  // ใส่ header พื้นฐานทุกครั้ง (สำหรับ preflight)
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Max-Age", "86400"); // cache preflight 24 ชม.

  // ตอบ preflight
  if (req.method === "OPTIONS") {
    // ถ้าต้องการให้ผ่านทุกกรณีชั่วคราว:
    // if (!hasOrigin && DEV_ALLOW_ALL) res.set("Access-Control-Allow-Origin", "*");
    res.status(204).send("");
    return true;
  }

  // ถ้าไม่มี origin (เช่นเปิด URL ตรง) — อนุญาตให้ทำงานต่อได้ เพื่อเทส ping/เปิดดู
  if (!hasOrigin) return false;

  // ถ้ามี origin แต่ไม่แมตช์ allowlist -> บล็อก
  if (!allowed) {
    console.warn("CORS blocked for origin:", origin);
    res.status(403).send("CORS blocked");
    return true;
  }

  return false;
}
/* ======================= จบ CORS ======================= */

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

// Storage trigger ทำ thumbnail + เติม photos[]
exports.onIssuePhotoUploaded = onIssuePhotoUploaded({ admin });

// ping สำหรับเทส URL โดยตรง (พิมพ์เข้าเบราว์เซอร์ได้ ไม่ถูก CORS บล็อก)
exports.ping = onRequest((req, res) => {
  if (applyCors(req, res)) return; // จะไม่บล็อกกรณีไม่มี Origin
  res.json({ ok: true, codebase: "issues", at: new Date().toISOString() });
});
