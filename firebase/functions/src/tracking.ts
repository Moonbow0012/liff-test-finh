import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import crypto from "crypto";

/* ===== Admin SDK v12 (ESM modular) ===== */
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

/* ===== Init app (modular only) ===== */
if (!getApps().length) initializeApp();
const auth = getAuth();
const db = getFirestore();

/* ===== CORS & helpers ===== */
const ALLOW_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "https://liff-test-finh-n8ql.vercel.app",
  "https://liff-test-finh-tracking.vercel.app",
]);

const ORIGIN_REGEX = [
  /^https:\/\/liff-test-finh-[a-z0-9-]+\.vercel\.app$/i,
  /^https:\/\/liff-test-finh-tracking-[a-z0-9-]+\.vercel\.app$/i,
];

function isAllowedOrigin(origin?: string): boolean {
  return !!origin && (ALLOW_ORIGINS.has(origin) || ORIGIN_REGEX.some((r) => r.test(origin)));
}

function setCors(req: any, res: any): void {
  const origin = req.header("Origin");
  res.set("Vary", "Origin");
  if (isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin!);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", req.header("Access-Control-Request-Headers") || "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "3600");
  }
}

async function linePush(token: string, to: string, messages: any) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ to, messages: Array.isArray(messages) ? messages : [messages] })
  });
  const bodyText = await r.text().catch(() => "");
  const log = { tag: "line.push", ok: r.ok, status: r.status, to, bodyPreview: bodyText.slice(0, 500) };
  if (r.ok) console.log(log); else console.error(log);
  return { ok: r.ok, status: r.status, body: bodyText };
}


/* ===== Timestamp helpers ===== */
const serverTs = () => FieldValue.serverTimestamp(); // ใช้กับ field top-level
const tsNow = () => Timestamp.now();                 // ใช้ใน arrayUnion

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
  if (!m) { endJson(res, 401, { ok: false, error: "UNAUTHENTICATED" }); return null; }
  try { return await auth.verifyIdToken(m[1]); }
  catch { endJson(res, 401, { ok: false, error: "UNAUTHENTICATED" }); return null; }
}

/* ===== Tracking core ===== */
const TRACK_STATES = new Set(["CREATED", "RECEIVED", "IN_PROGRESS", "QA", "COMPLETED", "ON_HOLD", "CANCELLED", "FAILED"]);
function makeSerial(prefix = "WX") {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.floor(Math.random() * Math.pow(36, 5)).toString(36).toUpperCase().padStart(5, "0");
  return `${prefix}-${y}${m}${day}-${rand}`;
}
const normalizeLevel = (lv: any) => Math.max(0, Math.min(4, Number.isFinite(+lv) ? Math.round(+lv) : 1));
const sanitizeTitle = (s: any) => (!s || typeof s !== "string") ? "Tracking" : s.slice(0, 140);

async function getTrackingDoc(serial: string) {
  if (!serial) return null;
  const ref = db.collection("tracking").doc(serial);
  const snap = await ref.get();
  return snap.exists ? { ref, data: snap.data() as any } : null;
}

/* === 1) สร้างเลขติดตาม === */
export const trkCreate = onRequest({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 1,
  minInstances: 0,
  concurrency: 80
}, async (req, res): Promise<void> => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { endJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }); return; }

  const decoded = await verifyFirebaseIdTokenFromHeader(req, res);
  if (!decoded) return;

  try {
    const b = jsonBody(req);
    const serial = makeSerial("WX");
    const firstState = TRACK_STATES.has(b.firstState) ? b.firstState : "CREATED";

    const entry = {
      code: firstState,
      text: b.firstText || (firstState === "CREATED" ? "สร้างคำขอแล้ว" : firstState),
      at: tsNow(),
      by: (decoded as any).uid || null,
      note: b.firstNote ?? null,
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
      createdAt: serverTs(),
      updatedAt: serverTs(),
      ownerUid: (decoded as any).uid || null,
      public: true,
    };

    await db.collection("tracking").doc(serial).set(doc);
    endJson(res, 200, { ok: true, serial });
  } catch (e: any) {
    const err = { name: e?.name || null, code: e?.code || null, message: e?.message || String(e), stack: e?.stack || null };
    console.error("[trkCreate] error", err);
    const DEBUG_ERRORS = true;
    endJson(res, 500, { ok: false, error: "INTERNAL_ERROR", message: err.message, code: err.code, ...(DEBUG_ERRORS ? { stack: err.stack } : {}) });
  }
});

/* === 2) อัปเดตสถานะ === */
export const trkUpdate = onRequest({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 1,
  minInstances: 0,
  concurrency: 80
}, async (req, res): Promise<void> => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { endJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }); return; }

  const decoded = await verifyFirebaseIdTokenFromHeader(req, res);
  if (!decoded) return;

  try {
    const b = jsonBody(req);

    const serial = String(b.serial || "").trim().toUpperCase();
    if (!serial) { endJson(res, 400, { ok: false, error: "MISSING_SERIAL" }); return; }

    const code = String(b.code || "");
    if (!TRACK_STATES.has(code)) { endJson(res, 400, { ok: false, error: "INVALID_STATE" }); return; }

    const doc = await getTrackingDoc(serial);
    if (!doc) { endJson(res, 404, { ok: false, error: "NOT_FOUND" }); return; }

    const currLevel = (doc.data as any)?.statusLevel ?? 1;
    const level = normalizeLevel((b.level ?? currLevel));

    const entry = {
      code,
      text: (b.text || code),
      at: tsNow(),
      by: (decoded as any).uid || null,
      note: b.note ?? null,
    };

    await doc.ref.update({
      state: code,
      statusText: entry.text,
      statusLevel: level,
      statusHistory: FieldValue.arrayUnion(entry),
      updatedAt: serverTs(),
    });

    endJson(res, 200, { ok: true });
  } catch (e: any) {
    const err = { name: e?.name || null, code: e?.code || null, message: e?.message || String(e), stack: e?.stack || null };
    console.error("[trkUpdate] error", err);
    const DEBUG_ERRORS = true;
    endJson(res, 500, { ok: false, error: "INTERNAL_ERROR", message: err.message, code: err.code, ...(DEBUG_ERRORS ? { stack: err.stack } : {}) });
  }
});

/* === 3) อ่านสถานะ (สาธารณะ) === */
export const trkGet = onRequest({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 30,
  maxInstances: 1,
  minInstances: 0,
  concurrency: 80
}, async (req, res): Promise<void> => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { endJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }); return; }

  try {
    const serial = String(req.query.serial || "").trim();
    if (!serial) { endJson(res, 400, { ok: false, error: "MISSING_SERIAL" }); return; }

    const doc = await getTrackingDoc(serial);
    if (!doc) { endJson(res, 404, { ok: false, error: "NOT_FOUND" }); return; }
    const d: any = doc.data;
    if (d.public !== true) { endJson(res, 403, { ok: false, error: "FORBIDDEN" }); return; }

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
    endJson(res, 200, { ok: true, tracking: out });
  } catch (e: any) {
    console.error("[trkGet] error", e);
    endJson(res, 500, { ok: false, error: "INTERNAL_ERROR", message: e?.message || String(e) });
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
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages) ? messages : [messages] })
  });

  const bodyText = await r.text().catch(() => "");
  const log = {
    tag: "line.reply",
    ok: r.ok,
    status: r.status,
    replyTokenLen: (replyToken || "").length,
    bodyPreview: bodyText.slice(0, 500),
    service: process.env.K_SERVICE,
    revision: process.env.K_REVISION,
  };

  if (r.ok) console.log(log);
  else console.error(log);

  return { ok: r.ok, status: r.status, body: bodyText };
}

/* ===== Flex helpers ===== */
const LIFF_TRACK_URL = "https://liff-test-finh-tracking.vercel.app/";
function toDateMaybe(x: any): Date | null {
  if (!x) return null;
  if (typeof x?.toDate === "function") return x.toDate();
  if (x?._seconds) return new Date(x._seconds * 1000);
  if (typeof x === "number" || typeof x === "string") return new Date(x);
  return null;
}
function fmtTh(d: Date | null): string {
  if (!d) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}
function buildFlex(tracking: any) {
  const stateColors: Record<string, string> = {
    CREATED: "#6B7280", RECEIVED: "#3B82F6", IN_PROGRESS: "#F59E0B",
    QA: "#8B5CF6", COMPLETED: "#10B981", ON_HOLD: "#9CA3AF",
    CANCELLED: "#EF4444", FAILED: "#EF4444",
  };
  const levelColors = ["#9CA3AF", "#3B82F6", "#F59E0B", "#EF4444", "#10B981"];
  const level = Math.max(0, Math.min(4, Number(tracking.statusLevel ?? 1)));
  const state = String(tracking.state || "CREATED").toUpperCase();
  const color = stateColors[state] || levelColors[level];

  const hist = Array.isArray(tracking.statusHistory) ? tracking.statusHistory.slice(-5).reverse() : [];
  const items = hist.length
    ? hist.map((h: any) => ({
        type: "box", layout: "vertical", spacing: "xs",
        contents: [
          { type: "text", text: h.code || "-", size: "sm", weight: "bold" },
          { type: "text", text: h.text || "-", size: "sm", wrap: true, color: "#6B7280" },
          { type: "text", text: fmtTh(toDateMaybe(h.at ?? null)), size: "xs", color: "#9CA3AF" }
        ]
      }))
    : [{ type: "text", text: "ยังไม่มีไทม์ไลน์", size: "sm", color: "#9CA3AF" }];

const levelDots = Array.from({ length: 5 }).map((_, i) => ({
  type: "box",
  layout: "vertical",
  contents: [],                 // ← สำคัญ! Flex box ต้องมี contents เสมอ
  width: "10px",
  height: "10px",
  cornerRadius: "10px",
  backgroundColor: i <= level ? color : "#E5E7EB",
}));

  return {
    type: "flex",
    altText: `สถานะ ${tracking.serial}: ${state}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: "#FFFFFF",
        contents: [
          { type: "text", text: "Tracking", size: "xs", color: "#6B7280" },
          { type: "text", text: tracking.serial || "-", weight: "bold", size: "lg" },
          { type: "text", text: tracking.title || "-", size: "sm", color: "#6B7280", wrap: true },
        ],
      },
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "box", layout: "baseline", contents: [
              { type: "text", text: "สถานะ", size: "sm", color: "#6B7280" },
              { type: "text", text: state, size: "md", weight: "bold", color },
            ] },
          { type: "box", layout: "horizontal", spacing: "xs", contents: levelDots },
          { type: "separator" },
          { type: "box", layout: "vertical", spacing: "sm", contents: items }
        ]
      },
      footer: {
        type: "box", layout: "horizontal", contents: [
          { type: "button", style: "primary",
            action: { type: "uri", label: "เปิดใน LIFF", uri: `${LIFF_TRACK_URL}?serial=${encodeURIComponent(tracking.serial)}` },
            color }
        ]},
      styles: { header: { separator: true } }
    },
    quickReply: {
      items: [{ type: "action", action: { type: "message", label: "ดูเลขอื่น", text: "พิมพ์เลขติดตาม เช่น WX-250922-ABCDE" } }]
    }
  };
}

/* === Webhook === */
export const lineWebhookTracking = onRequest({
  region: "asia-southeast1",
  memory: "128MiB",
  timeoutSeconds: 15,
  maxInstances: 1,
  minInstances: 0,
  concurrency: 40,
  secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN]
}, async (req, res): Promise<void> => {
  if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
  if (!verifyLineSignature(req, LINE_CHANNEL_SECRET.value())) { res.status(401).send("Bad signature"); return; }

  const body = jsonBody(req);
  const events = Array.isArray(body.events) ? body.events : [];

  for (const ev of events) {
    try {
      // สนใจเฉพาะข้อความตัวอักษร
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      // normalize: ตัดช่องว่าง + uppercase
      const raw = String(ev.message.text || "");
      const txt = raw.replace(/\s+/g, "").toUpperCase();
      const m = txt.match(/[A-Z]{2}-\d{6}-[A-Z0-9]{5}/);
      if (!m) continue; // ไม่ใช่โค้ดตามแพทเทิร์น → เงียบ ให้ OA จัดการ

      const serial = m[0];
      const doc = await getTrackingDoc(serial);

      // ถ้าเป็นรูปแบบโค้ดแต่ "ไม่พบ/ไม่ public" → ตอบว่าโค้ดผิด
      if (!doc || (doc.data as any)?.public !== true) {
        await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, {
          type: "text",
          text: `รหัสติดตามไม่ถูกต้อง: ${serial}`
        });
        continue;
      }

      // พบ + public → ตอบสถานะด้วย Flex
      const d: any = doc.data;
      const tracking = {
        serial: d.serial,
        title: d.title,
        state: d.state,
        statusText: d.statusText,
        statusLevel: d.statusLevel,
        statusHistory: Array.isArray(d.statusHistory) ? d.statusHistory : []
      };

      await lineReply(LINE_CHANNEL_ACCESS_TOKEN.value(), ev.replyToken, buildFlex(tracking));
    } catch (e) {
      console.error("[lineWebhookTracking] event error", e);
      // ไม่ตอบ error กลับ เพื่อให้ OA จัดการข้อความอื่นได้ตามต้องการ
    }
  }

  res.status(200).send("OK");
});

// tracking.ts
import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
admin.initializeApp();
const db = admin.firestore();

async function requireUID(req: any){
  // TODO: ยืนยัน LINE token จาก headers (x-line-id-token) → คืน userId
  // ชั่วคราว: ยอมให้ผ่านเพื่อพัฒนา UI
  return "dev-user";
}

export const createOrJoinFarm = onRequest({ region:"asia-southeast1", cors:true }, async (req, res)=>{
  try{
    const uid = await requireUID(req);
    const { name, lat, lng, address } = req.body || {};
    if (!name || typeof lat!=="number" || typeof lng!=="number") throw new Error("missing name/lat/lng");
    // ถ้าเคยมีฟาร์มอยู่แล้ว ก็รีเทิร์นไปเฉย ๆ
    const mem = await db.collectionGroup("members").where("uid","==",uid).limit(1).get();
    if (!mem.empty){
      const farmRef = mem.docs[0].ref.parent.parent!;
      const doc = await farmRef.get();
      return res.json({ ok:true, farmId:farmRef.id, farm: { id:farmRef.id, ...doc.data() }});
    }
    const farmRef = db.collection("farms").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await farmRef.set({
      name, location:{ lat, lng, address: address||null }, createdBy: uid, createdAt: now, membersCount:1
    });
    await farmRef.collection("members").doc(uid).set({ uid, role:"owner", joinedAt: now });
    const doc = await farmRef.get();
    res.json({ ok:true, farmId:farmRef.id, farm: { id:farmRef.id, ...doc.data() }});
  }catch(e:any){ res.status(400).json({ error:e.message||String(e) }); }
});

export const myFarm = onRequest({ region:"asia-southeast1", cors:true }, async (req, res)=>{
  try{
    const uid = await requireUID(req);
    const snap = await db.collectionGroup("members").where("uid","==",uid).limit(1).get();
    if (snap.empty) return res.json({ farm:null });
    const farmRef = snap.docs[0].ref.parent.parent!;
    const doc = await farmRef.get();
    res.json({ farm: { id: farmRef.id, ...doc.data() }});
  }catch(e:any){ res.status(400).json({ error:e.message||String(e) }); }
});

// คืนรายการ Harvest + lineage แบบย่อยๆ
export const harvests = onRequest({ region:"asia-southeast1", cors:true }, async (req, res)=>{
  try{
    const uid = await requireUID(req);
    const farmId = String(req.query.farmId||"");
    const limit  = Math.min(200, Number(req.query.limit||50));
    if (!farmId) throw new Error("missing farmId");

    const base = db.collection(`farms/${farmId}/harvests`).orderBy("date","desc").limit(limit);
    const hs = await base.get();
    const items:any[] = [];
    for (const h of hs.docs){
      const hv = { id:h.id, ...h.data() };
      // lineage จาก pivot (เอาชื่อให้พอดู)
      const piv = await db.collection(`farms/${farmId}/harvest_crops`).where("harvestId","==", h.id).get();
      const cropIds = piv.docs.map(d=>d.data().cropId);
      let from:any = null;
      if (cropIds.length){
        const cdoc = await db.doc(`farms/${farmId}/crops/${cropIds[0]}`).get();
        const crop = cdoc.exists ? { id:cdoc.id, ...cdoc.data() } : null;
        let tray=null, pond=null;
        if (crop){
          const tdoc = await db.doc(`farms/${farmId}/trays/${(crop as any).trayId}`).get();
          const pdoc = await db.doc(`farms/${farmId}/ponds/${(crop as any).pondId}`).get();
          tray = tdoc.exists ? ((tdoc.data() as any).code || tdoc.id) : null;
          pond = pdoc.exists ? ((pdoc.data() as any).code || pdoc.id) : null;
        }
        from = { pond, tray, crops: cropIds };
      }
      items.push({
        id: hv.id,
        date: hv.date,
        weightKg: hv.weightKg ?? null,
        moisture: hv.moisture ?? null,
        qcResult: hv.qcResult ?? null,
        from
      });
    }
    res.json({ items });
  }catch(e:any){ res.status(400).json({ error:e.message||String(e) }); }
});
