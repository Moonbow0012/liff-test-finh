// functions-tracking/index.js
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");

// ---------- Admin init ----------
try { admin.app(); } catch { admin.initializeApp(); }
setGlobalOptions({ region: "asia-southeast1", memory: "256MiB", timeoutSeconds: 60 });

// ---------- CORS ----------
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  // ถ้ามีโดเมนหน้า status แยก/โดเมน production ให้ใส่เพิ่มตรงนี้ (ห้ามมี / ท้าย)
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
function jsonBody(req) {
  try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { return {}; }
}
async function verifyFirebaseIdTokenFromHeader(req, res) {
  const m = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) { endJson(res, 401, { ok:false, error:"UNAUTHENTICATED" }); return null; }
  try { return await admin.auth().verifyIdToken(m[1]); }
  catch { endJson(res, 401, { ok:false, error:"UNAUTHENTICATED" }); return null; }
}

// ---------- Helpers ----------
const TRACK_STATES = new Set(["CREATED","RECEIVED","IN_PROGRESS","QA","COMPLETED","ON_HOLD","CANCELLED","FAILED"]);
const nowTs = () => admin.firestore.FieldValue.serverTimestamp();
function makeSerial(prefix="WX") {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
  const rand = Math.floor(Math.random()*Math.pow(36,5)).toString(36).toUpperCase().padStart(5,"0");
  return `${prefix}-${y}${m}${day}-${rand}`;
}
const normalizeLevel = lv => Math.max(0, Math.min(4, Number.isFinite(+lv) ? Math.round(+lv) : 1));
const sanitizeTitle = s => (!s || typeof s!=="string") ? "Tracking" : s.slice(0,140);
async function getTrackingDoc(serial) {
  if (!serial) return null;
  const ref = admin.firestore().collection("tracking").doc(serial);
  const snap = await ref.get();
  return snap.exists ? { ref, data: snap.data() } : null;
}

// ---------- 1) สร้างเลขติดตาม ----------
exports.trkCreate = onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  const decoded = await verifyFirebaseIdTokenFromHeader(req, res);
  if (!decoded) return;

  try {
    const b = jsonBody(req);
    const serial = makeSerial("WX");
    const firstState = TRACK_STATES.has(b.firstState) ? b.firstState : "CREATED";
    const entry = {
      code: firstState,
      text: b.firstText || (firstState === "CREATED" ? "สร้างคำขอแล้ว" : firstState),
      at: nowTs(),
      by: decoded.uid || null,
      note: b.firstNote ?? null
    };
    const doc = {
      serial,
      issueId: b.issueId ?? null,
      title: sanitizeTitle(b.title || "GAqP Tracking"),
      farmId: b.farmId ?? null,
      plotId: b.plotId ?? null,
      state: firstState,
      statusText: entry.text,
      statusLevel: normalizeLevel(b.firstLevel ?? 1),
      statusHistory: [entry],
      createdAt: nowTs(),
      updatedAt: nowTs(),
      ownerUid: decoded.uid || null,
      public: true
    };
    await admin.firestore().collection("tracking").doc(serial).set(doc);
    return endJson(res, 200, { ok:true, serial });
  } catch (e) {
    console.error("[trkCreate] error", e);
    return endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

// ---------- 2) อัปเดตสถานะ ----------
exports.trkUpdate = onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  const decoded = await verifyFirebaseIdTokenFromHeader(req, res);
  if (!decoded) return;

  try {
    const b = jsonBody(req);
    if (!b.serial) return endJson(res, 400, { ok:false, error:"MISSING_SERIAL" });
    if (!TRACK_STATES.has(b.code)) return endJson(res, 400, { ok:false, error:"INVALID_STATE" });

    const doc = await getTrackingDoc(b.serial);
    if (!doc) return endJson(res, 404, { ok:false, error:"NOT_FOUND" });

    const entry = { code: b.code, text: b.text || b.code, at: nowTs(), by: decoded.uid || null, note: b.note ?? null };
    await doc.ref.update({
      state: b.code,
      statusText: entry.text,
      statusLevel: normalizeLevel(b.level ?? doc.data.statusLevel ?? 1),
      statusHistory: admin.firestore.FieldValue.arrayUnion(entry),
      updatedAt: nowTs()
    });

    return endJson(res, 200, { ok:true });
  } catch (e) {
    console.error("[trkUpdate] error", e);
    return endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

// ---------- 3) อ่านสถานะ (สาธารณะ) ----------
exports.trkGet = onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" });

  try {
    const serial = (req.query.serial || "").toString().trim();
    if (!serial) return endJson(res, 400, { ok:false, error:"MISSING_SERIAL" });

    const doc = await getTrackingDoc(serial);
    if (!doc) return endJson(res, 404, { ok:false, error:"NOT_FOUND" });
    const d = doc.data;
    if (d.public !== true) return endJson(res, 403, { ok:false, error:"FORBIDDEN" });

    const out = {
      serial: d.serial,
      title: d.title,
      farmId: d.farmId ?? null,
      plotId: d.plotId ?? null,
      state: d.state,
      statusText: d.statusText,
      statusLevel: d.statusLevel ?? 1,
      statusHistory: (d.statusHistory || []).map(x => ({ code: x.code, text: x.text, at: x.at ?? null, note: x.note ?? null })),
      updatedAt: d.updatedAt ?? null
    };
    return endJson(res, 200, { ok:true, tracking: out });
  } catch (e) {
    console.error("[trkGet] error", e);
    return endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

// ---------- 4) LINE webhook -> Flex message ----------
const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

function verifyLineSignature(req, secret) {
  const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody || "");
  const hmac = crypto.createHmac("sha256", secret); hmac.update(body);
  return hmac.digest("base64") === (req.header("X-Line-Signature") || "");
}
function buildFlex(tracking) {
  const colors = ["#9CA3AF","#3B82F6","#F59E0B","#EF4444","#10B981"];
  const color = colors[Math.max(0, Math.min(4, tracking.statusLevel || 1))];
  const items = (tracking.statusHistory || []).slice(-5).reverse().map(h => ({
    type:"box", layout:"baseline", spacing:"sm",
    contents:[
      { type:"text", text:h.code, size:"sm", weight:"bold" },
      { type:"text", text:h.text, size:"sm", wrap:true, color:"#6B7280" }
    ]
  }));
  return {
    type:"flex",
    altText:`สถานะ ${tracking.serial}: ${tracking.state}`,
    contents:{
      type:"bubble",
      header:{ type:"box", layout:"vertical", contents:[
        { type:"text", text:"Tracking", size:"sm", color:"#6B7280" },
        { type:"text", text:tracking.serial, weight:"bold", size:"lg" },
        { type:"text", text:tracking.title||"-", size:"sm", color:"#6B7280", wrap:true }
      ]},
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"box", layout:"vertical", contents:[
          { type:"text", text:`สถานะ: ${tracking.state}`, weight:"bold", size:"md", color }
        ]},
        { type:"separator" },
        { type:"box", layout:"vertical", spacing:"sm", contents: items.length? items : [{ type:"text", text:"ยังไม่มีไทม์ไลน์", size:"sm", color:"#9CA3AF" }] }
      ]},
      styles:{ header:{ separator:true } }
    }
  };
}
async function lineReply(accessToken, replyToken, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+accessToken },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages)? messages : [messages] })
  });
}
exports.lineWebhookTracking = onRequest({ secrets:[LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (!verifyLineSignature(req, LINE_CHANNEL_SECRET.value())) return res.status(401).send("Bad signature");

  const events = Array.isArray(jsonBody(req).events) ? jsonBody(req).events : [];
  for (const ev of events) {
    try {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;
      const txt = (ev.message.text||"").trim();
      const m = txt.match(/[A-Z]{2}-\d{6}-[A-Z0-9]{5}/i);
      if (!m) {
        await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, { type:"text", text:"พิมพ์เลขติดตาม เช่น WX-250919-7F4K2" });
        continue;
      }
      const serial = m[0].toUpperCase();
      const doc = await getTrackingDoc(serial);
      if (!doc || doc.data.public !== true) {
        await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, { type:"text", text:`ไม่พบเลขติดตาม ${serial}` });
        continue;
      }
      const t = doc.data;
      const tracking = { serial:t.serial, title:t.title, state:t.state, statusText:t.statusText, statusLevel:t.statusLevel, statusHistory:t.statusHistory||[] };
      await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, buildFlex(tracking));
    } catch (e) {
      console.error("[lineWebhookTracking] event error", e);
      try { await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, { type:"text", text:"เกิดข้อผิดพลาด กรุณาลองใหม่" }); } catch {}
    }
  }
  return res.status(200).send("OK");
});
