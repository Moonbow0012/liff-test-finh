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
export const createOrJoinFarm = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") throw new HttpsError("invalid-argument","POST only");

    const { name, lat, lng, address } = (typeof req.body === "object" ? req.body : {}) as any;
    const uid = (req.get("x-dev-uid") || "").trim();
    if (!uid) throw new HttpsError("unauthenticated","missing x-dev-uid");
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpsError("invalid-argument", "name/lat/lng required");
    }

    const db = getFirestore();
    const farms = db.collection("farms");

    // หาเดิมตาม name (หรือจะใช้ slug/code ก็ได้)
    let farmRef = farms.doc();
    const existing = await farms.where("name","==", String(name).trim()).limit(1).get();
    if (!existing.empty) farmRef = existing.docs[0].ref;

    await db.runTransaction(async tx => {
      const snap = await tx.get(farmRef);

      // สร้างถ้ายังไม่มี / อัปเดตถ้ามีอยู่แล้ว → เลี่ยง precondition ด้วย merge:true
      tx.set(farmRef, {
        name: String(name).trim(),
        lat: Number(lat),
        lng: Number(lng),
        address: address ?? null,
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true });

      // ผูกสมาชิก (ก็ใช้ set merge true เช่นกัน)
      const memberRef = farmRef.collection("members").doc(uid);
      tx.set(memberRef, {
        role: "owner",
        joinedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    res.json({ ok:true, farmId: farmRef.id });
  } catch (e: any) {
    const code = e?.code || "internal";
    const msg  = e?.message || String(e);
    const status =
      code === "invalid-argument" ? 400 :
      code === "unauthenticated"  ? 401 :
      code === "permission-denied"? 403 :
      code === "failed-precondition"? 400 : 500;

    // ใส่ข้อความให้ครบ (จะได้ไม่เจอ “FAILED_PRECONDITION:” เปล่าๆ)
    res.status(status).json({ error: `${code}: ${msg}` });
  }
});

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
