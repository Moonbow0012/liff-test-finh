import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import crypto from "crypto";

// ===== Admin SDK (ESM modular) =====
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

// ===== CORS & helpers =====
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  // ใส่โดเมนหน้าเว็บอื่น ๆ เพิ่มตรงนี้ (ห้ามมี "/" ท้าย)
]);

function setCors(req: any, res: any): void {
  const origin = req.header("Origin");
  res.set("Vary", "Origin");
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "3600");
  }
}

function endJson(res: any, code: number, obj: any): void {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.status(code).json(obj);
}

function jsonBody(req: any) {
  try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { return {}; }
}

async function verifyFirebaseIdTokenFromHeader(req: any, res: any) {
  const m = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) { endJson(res, 401, { ok:false, error:"UNAUTHENTICATED" }); return null; }
  try { return await getAuth().verifyIdToken(m[1]); }
  catch { endJson(res, 401, { ok:false, error:"UNAUTHENTICATED" }); return null; }
}

// ===== Tracking core =====
const db = getFirestore();
const TRACK_STATES = new Set(["CREATED", "RECEIVED", "IN_PROGRESS", "QA", "COMPLETED", "ON_HOLD", "CANCELLED", "FAILED"]);
const nowTs = () => FieldValue.serverTimestamp();

function makeSerial(prefix = "WX") {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.floor(Math.random() * Math.pow(36, 5)).toString(36).toUpperCase().padStart(5, "0");
  return `${prefix}-${y}${m}${day}-${rand}`;
}

const normalizeLevel = (lv: any) => Math.max(0, Math.min(4, Number.isFinite(+lv) ? Math.round(+lv) : 1));
const sanitizeTitle  = (s: any) => (!s || typeof s !== "string") ? "Tracking" : s.slice(0, 140);

async function getTrackingDoc(serial: string) {
  if (!serial) return null;
  const ref = db.collection("tracking").doc(serial);
  const snap = await ref.get();
  return snap.exists ? { ref, data: snap.data() as any } : null;
}

/* === 1) สร้างเลขติดตาม === */
export const trkCreate = onRequest({ region: "asia-southeast1" },async (req, res): Promise<void> => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" }); return; }

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
      by: (decoded as any).uid || null,
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
      ownerUid: (decoded as any).uid || null,
      public: true
    };
    await db.collection("tracking").doc(serial).set(doc);
    endJson(res, 200, { ok:true, serial });
  } catch (e: any) {
    console.error("[trkCreate] error", e);
    endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

/* === 2) อัปเดตสถานะ === */
export const trkUpdate = onRequest({ region: "asia-southeast1" },async (req, res): Promise<void> => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" }); return; }

  const decoded = await verifyFirebaseIdTokenFromHeader(req, res);
  if (!decoded) return;

  try {
    const b = jsonBody(req);
    if (!b.serial) { endJson(res, 400, { ok:false, error:"MISSING_SERIAL" }); return; }
    if (!TRACK_STATES.has(b.code)) { endJson(res, 400, { ok:false, error:"INVALID_STATE" }); return; }

    const doc = await getTrackingDoc(b.serial);
    if (!doc) { endJson(res, 404, { ok:false, error:"NOT_FOUND" }); return; }

    const entry = { code: b.code, text: b.text || b.code, at: nowTs(), by: (decoded as any).uid || null, note: b.note ?? null };
    await doc.ref.update({
      state: b.code,
      statusText: entry.text,
      statusLevel: normalizeLevel(b.level ?? (doc.data as any).statusLevel ?? 1),
      statusHistory: FieldValue.arrayUnion(entry),
      updatedAt: nowTs()
    });

    endJson(res, 200, { ok:true });
  } catch (e: any) {
    console.error("[trkUpdate] error", e);
    endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

/* === 3) อ่านสถานะ (สาธารณะ) === */
export const trkGet = onRequest({ region: "asia-southeast1" },async (req, res): Promise<void> => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { endJson(res, 405, { ok:false, error:"METHOD_NOT_ALLOWED" }); return; }

  try {
    const serial = String(req.query.serial || "").trim();
    if (!serial) { endJson(res, 400, { ok:false, error:"MISSING_SERIAL" }); return; }

    const doc = await getTrackingDoc(serial);
    if (!doc) { endJson(res, 404, { ok:false, error:"NOT_FOUND" }); return; }
    const d: any = doc.data;
    if (d.public !== true) { endJson(res, 403, { ok:false, error:"FORBIDDEN" }); return; }

    const out = {
      serial: d.serial,
      title: d.title,
      farmId: d.farmId ?? null,
      plotId: d.plotId ?? null,
      state: d.state,
      statusText: d.statusText,
      statusLevel: d.statusLevel ?? 1,
      statusHistory: (d.statusHistory || []).map((x: any) => ({
        code: x.code, text: x.text, at: x.at ?? null, note: x.note ?? null
      })),
      updatedAt: d.updatedAt ?? null
    };
    endJson(res, 200, { ok:true, tracking: out });
  } catch (e: any) {
    console.error("[trkGet] error", e);
    endJson(res, 500, { ok:false, error:"INTERNAL_ERROR", message: e?.message || String(e) });
  }
});

/* === 4) LINE webhook (Flex) === */
const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

function verifyLineSignature(req: any, secret: string) {
  const raw: Buffer = (req as any).rawBody || Buffer.from("");
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return sig === (req.header("X-Line-Signature") || "");
}

async function lineReply(token: string, replyToken: string, messages: any) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+token },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages)? messages : [messages] })
  });
}

function buildFlex(tracking: any) {
  const colors = ["#9CA3AF","#3B82F6","#F59E0B","#EF4444","#10B981"];
  const color = colors[Math.max(0, Math.min(4, tracking.statusLevel || 1))];
  const items = (tracking.statusHistory || []).slice(-5).reverse().map((h: any) => ({
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
        { type:"box", layout:"vertical", spacing:"sm",
          contents: items.length? items : [{ type:"text", text:"ยังไม่มีไทม์ไลน์", size:"sm", color:"#9CA3AF" }] }
      ]},
      styles:{ header:{ separator:true } }
    }
  };
}

export const lineWebhookTracking = onRequest({ region: "asia-southeast1", secrets:[LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN] }, async (req, res): Promise<void> => {
  if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
  if (!verifyLineSignature(req, LINE_CHANNEL_SECRET.value())) { res.status(401).send("Bad signature"); return; }

  const body = jsonBody(req);
  const events = Array.isArray(body.events) ? body.events : [];

  for (const ev of events) {
    try {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      const txt = (ev.message.text || "").trim();
      const m = txt.match(/[A-Z]{2}-\d{6}-[A-Z0-9]{5}/i);
      if (!m) {
        await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, { type:"text", text:"พิมพ์เลขติดตาม เช่น WX-250919-7F4K2" });
        continue;
      }

      const serial = m[0].toUpperCase();
      const doc = await getTrackingDoc(serial);
      if (!doc || (doc.data as any).public !== true) {
        await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, { type:"text", text:`ไม่พบเลขติดตาม ${serial}` });
        continue;
      }

      const t: any = doc.data;
      const tracking = { serial:t.serial, title:t.title, state:t.state, statusText:t.statusText, statusLevel:t.statusLevel, statusHistory:t.statusHistory||[] };
      await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, buildFlex(tracking));
    } catch (e) {
      console.error("[lineWebhookTracking] event error", e);
      try { await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, { type:"text", text:"เกิดข้อผิดพลาด กรุณาลองใหม่" }); } catch {}
    }   
  }

  res.status(200).send("OK");
  return;
});
