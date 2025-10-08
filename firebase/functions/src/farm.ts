import { onRequest, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as admin from "firebase-admin";

const _admin: any = admin || {};
if (!_admin.apps || !_admin.apps.length) {
  try { admin.initializeApp(); } catch (e) { /* ignore double init */ }
}
const db = admin.firestore();

/* ---------- CORS (allow Vercel + localhost) ---------- */
const ALLOWED_ORIGINS = new Set<string>([
  "https://liff-test-finh.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
]);
function setCors(req: any, res: any) {
  const origin = req.headers.origin as string | undefined;
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";
  res.set("Access-Control-Allow-Origin", allow);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, x-line-id-token, x-line-access-token, authorization, x-dev-uid"
  );
  res.set("Access-Control-Max-Age", "86400");
}
function withCors(handler: (req: any, res: any) => Promise<void> | void) {
  return async (req: any, res: any) => {
    setCors(req, res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    await handler(req, res);
  };
}

/* ---------- Auth helper (ชั่วคราว) ---------- */
async function requireUID(req: any): Promise<string> {
  // ใช้ header ชั่วคราว ถ้าไม่มีก็ใช้ fixed uid
  const dev = req.headers["x-dev-uid"];
  if (typeof dev === "string" && dev.trim()) return dev.trim();
  return "dev-user"; // ชั่วคราวพอ onboarding ผ่าน (จะย้ายไป verify LINE/Firebase ภายหลัง)
}

/* ---------- ดึงฟาร์มของผู้ใช้ ---------- */
async function getMyFarmFor(uid: string) {
  const snap = await db.collectionGroup("members")
    .where("uid", "==", uid)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const farmRef = snap.docs[0].ref.parent.parent!;
  const farmDoc = await farmRef.get();
  return { id: farmRef.id, ...(farmDoc.data() || {}) };
}

/* ---------- สร้าง/เข้าร่วมฟาร์ม ---------- */
export const createOrJoinFarm = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    const t0 = Date.now();
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
      }

      const uid = await requireUID(req);
      const b = (req.body || {}) as any;
      const name = (b.name ?? "").toString().trim();
      const lat  = typeof b.lat === "number" ? b.lat : Number(b.lat);
      const lng  = typeof b.lng === "number" ? b.lng : Number(b.lng);
      const address = b.address ? String(b.address) : null;

      // Validate เข้มงวด + log
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.error("[createOrJoinFarm] invalid input", { uid, name, lat, lng, address });
        res.status(400).json({ error: "invalid name/lat/lng" });
        return;
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      // (สำคัญ) ทำให้ idempotent และเลี่ยง precondition: ใช้ set(..., {merge:true})
      const farmRef = db.collection("farms").doc(); // auto-id
      await farmRef.set({
        name,
        location: { lat, lng, address: address || null },
        createdBy: uid,
        createdAt: now,
        updatedAt: now,
        membersCount: admin.firestore.FieldValue.increment ? admin.firestore.FieldValue.increment(1) : 1,
      }, { merge: true });

      // สมาชิกก็ใช้ merge:true เช่นกัน
      const memberRef = farmRef.collection("members").doc(uid);
      await memberRef.set({
        uid,
        role: "owner",
        joinedAt: now,
      }, { merge: true });

      const farmDoc = await farmRef.get();
      const payload = { ok: true, farmId: farmRef.id, farm: { id: farmRef.id, ...(farmDoc.data() || {}) } };

      console.log("[createOrJoinFarm] ok", { uid, farmId: farmRef.id, ms: Date.now() - t0 });
      res.json(payload);
    } catch (e: any) {
      // log ให้ครบทุกฟิลด์ที่สำคัญ เพื่อตามรอยได้ใน Logs Explorer
      console.error("[createOrJoinFarm] error", {
        code: e?.code,
        name: e?.name,
        message: e?.message,
        stack: e?.stack,
      });

      // ส่งข้อความกลับไปให้หน้าเว็บแบบอ่านง่าย
      const code = (e?.code || "").toString();
      const msg  = e?.message || String(e);
      // แปลง gRPC code 9 → HTTP 412 ให้สื่อความหมายกว่าเดิม
      const http = code === "9" || /FAILED_PRECONDITION/i.test(msg) ? 412 : 400;
      res.status(http).json({ error: msg || "FAILED_PRECONDITION" });
    }
  })
);

/* ---------- myFarm (คืน 200 เสมอ) ---------- */
export const myFarm = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    try {
      const uid = await requireUID(req);
      const farm = await getMyFarmFor(uid);
      res.json({ ok: true, farm: farm || null });
    } catch (e: any) {
      console.error("myFarm error:", e);
      // อย่า 400 — คืน 200 + ok:false ให้หน้าเว็บ handle ต่อ
      res.json({ ok: false, error: e?.message || String(e), farm: null });
    }
  })
);

/* ---------- harvests + lineage ---------- */
export const harvests = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    try {
      await requireUID(req);
      const farmId = String(req.query.farmId || "");
      const limit  = Math.min(200, Number(req.query.limit || 50));
      if (!farmId) { res.status(400).json({ error: "missing farmId" }); return; }

      const hs = await db.collection(`farms/${farmId}/harvests`)
        .orderBy("date", "desc").limit(limit).get();

      const items: any[] = [];
      for (const h of hs.docs) {
        const hvData = (h.data() as any) || {};
        const hv = { id: h.id, ...hvData };

        const piv = await db.collection(`farms/${farmId}/harvest_crops`)
          .where("harvestId", "==", h.id).get();

        const cropIds = piv.docs.map(d => (d.data() as any).cropId).filter(Boolean);
        let from: any = null;
        if (cropIds.length) {
          const cdoc = await db.doc(`farms/${farmId}/crops/${cropIds[0]}`).get();
          const crop = cdoc.exists ? ({ id: cdoc.id, ...(cdoc.data() as any) }) : null;
          let tray: string | null = null, pond: string | null = null;

          if (crop) {
            if (crop.trayId) {
              const tdoc = await db.doc(`farms/${farmId}/trays/${crop.trayId}`).get();
              if (tdoc.exists) { const t = tdoc.data() as any; tray = t?.code || tdoc.id; }
            }
            if (crop.pondId) {
              const pdoc = await db.doc(`farms/${farmId}/ponds/${crop.pondId}`).get();
              if (pdoc.exists) { const p = pdoc.data() as any; pond = p?.code || pdoc.id; }
            }
          }
          from = { pond, tray, crops: cropIds };
        }

        items.push({
          id: hv.id,
          date: hv.date ?? null,
          weightKg: hv.weightKg ?? null,
          moisture: hv.moisture ?? null,
          qcResult: hv.qcResult ?? null,
          from,
        });
      }

      res.json({ ok: true, items });
    } catch (e: any) {
      console.error("harvests error:", e);
      res.status(400).json({ error: e?.message || String(e) });
    }
  })
);

export const pingFirestore = onRequest(
  { region: "asia-southeast1" },
  withCors(async (_req, res) => {
    try {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ref = db.collection("_diagnostics").doc("ping");
      await ref.set({ at: now }, { merge: true });
      const snap = await ref.get();
      res.json({ ok: true, at: snap.get("at") || null });
    } catch (e: any) {
      console.error("[pingFirestore] error", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  })
);
