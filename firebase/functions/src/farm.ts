import { onRequest, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const _admin: any = admin || {};
if (!_admin.apps || !_admin.apps.length) {
  try { admin.initializeApp(); } catch (_e) {}
}
const db = admin.firestore();

/** ---------------- CORS ---------------- */
const ALLOWED = new Set<string>([
  "https://liff-test-finh.vercel.app",
  "http://localhost:3000","http://127.0.0.1:3000",
  "http://localhost:5173","http://127.0.0.1:5173",
]);
function withCors(
  handler: (req: any, res: any) => Promise<void> | void
) {
  return async (req: any, res: any) => {
    const origin = req.headers.origin as string | undefined;
    if (origin && ALLOWED.has(origin)) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Content-Type, x-dev-uid");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    return handler(req, res);
  };
}

/** -------------- Auth helper -------------- */
async function requireUID(req: any): Promise<string> {
  const dev = req.headers["x-dev-uid"];
  if (typeof dev === "string" && dev.trim()) return dev.trim();
  // NOTE: keep fallback for onboarding
  return "dev-user";
}

/** -------------- ID helpers -------------- */
const PAD2 = (n:number) => n.toString().padStart(2, "0");

async function nextCounter(farmId: string, key: string): Promise<number> {
  const ref = db.doc(`farms/${farmId}/meta/counters`);
  let out = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists ? (snap.data() as any) : {});
    const cur = Number(data[key] || 0) + 1;
    tx.set(ref, { [key]: cur }, { merge: true });
    out = cur;
  });
  return out;
}

/** -------------- Ensure mapping user_farms -------------- */
async function linkUserFarm(uid: string, farmId: string) {
  await db.collection("user_farms").doc(uid).set({
    uid,
    farmId,
    linkedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/** -------------- myFarm (exact) -------------- */
export const myFarm = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    try {
      const uid = await requireUID(req);
      // lookup by mapping first
      const mapDoc = await db.collection("user_farms").doc(uid).get();
      if (mapDoc.exists) {
        const farmId = (mapDoc.data() as any).farmId as string;
        if (farmId) {
          const f = await db.doc(`farms/${farmId}`).get();
          res.json({ ok: true, farm: f.exists ? { id: farmId, ...(f.data()||{}) } : null });
          return;
        }
      }
      // fallback search collectionGroup members
      const cg = await db.collectionGroup("members").where("uid","==",uid).limit(1).get();
      if (!cg.empty) {
        const farmRef = cg.docs[0].ref.parent.parent!;
        const f = await farmRef.get();
        res.json({ ok: true, farm: f.exists ? { id: farmRef.id, ...(f.data()||{}) } : null });
        return;
      }
      res.json({ ok: true, farm: null });
    } catch (e:any) {
      console.error("[myFarm] error", e);
      res.json({ ok: false, error: e?.message || String(e), farm: null });
    }
  })
);

/** -------------- createOrJoinFarm -------------- */
export const createOrJoinFarm = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    try {
      if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
      const uid = await requireUID(req);
      const b = (req.body || {}) as any;
      const name = (b.name ?? "").toString().trim();
      const lat  = typeof b.lat === "number" ? b.lat : Number(b.lat);
      const lng  = typeof b.lng === "number" ? b.lng : Number(b.lng);
      const address = b.address ? String(b.address) : null;

      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        res.status(400).json({ error: "invalid name/lat/lng" }); return;
      }

      // check existing
      const existing = await db.collection("user_farms").doc(uid).get();
      if (existing.exists && (existing.data() as any).farmId) {
        const farmId = (existing.data() as any).farmId as string;
        const snap = await db.doc(`farms/${farmId}`).get();
        res.json({ ok: true, farmId, farm: { id: farmId, ...(snap.data()||{}) } });
        return;
      }

      // create farm
      const farmRef = db.collection("farms").doc();
      const now = admin.firestore.FieldValue.serverTimestamp();
      await farmRef.set({
        name,
        location: { lat, lng, address },
        createdAt: now,
        updatedAt: now,
        createdBy: uid,
      });

      // member
      await farmRef.collection("members").doc(uid).set({
        uid, role: "owner", joinedAt: now
      });

      // mapping
      await linkUserFarm(uid, farmRef.id);

      // -------- scaffold (1 each) following Excel schema --------
      const sidNum = await nextCounter(farmRef.id, "site");
      const sid = `S${PAD2(sidNum)}`;
      await farmRef.collection("sites").doc(sid).set({
        sid,
        sname: "Site 1",
        location: address ?? null,        // Excel: string (url); seed as address/null
        area_m2: null,
        sum_capacity: null,
        wtype: null,
      });

      const pidNum = await nextCounter(farmRef.id, "pond");
      const pid = `P${PAD2(pidNum)}`;
      await farmRef.collection("ponds").doc(pid).set({
        pid,
        pname: "Pond 1",
        sid,
        sum_capacity_kg: null,
      });

      const tidNum = await nextCounter(farmRef.id, "tray");
      const tid = `T${PAD2(tidNum)}`;
      await farmRef.collection("trays").doc(tid).set({
        tid,
        name: "Tray 1",
        pid,
        sid,
        capacity_kg: null,
        sum_capacity: null,
        sum_havest: null,
        act_harvest: null,
      });

      const cidNum = await nextCounter(farmRef.id, "crop");
      const cid = `C${PAD2(cidNum)}`;
      await farmRef.collection("crops").doc(cid).set({
        cid,
        cname: "Crop 1",
        tid,
        pid,
        sid,
        start_date: null,
        end_date: null,
        in_capacity_kg: null,
        cap_factor: null,
        out_capacity_kg: null,
      });

      // harvest_crops: intentionally empty on seed

      const snap = await farmRef.get();
      res.json({ ok: true, farmId: farmRef.id, farm: { id: farmRef.id, ...(snap.data()||{}) } });
    } catch (e:any) {
      console.error("[createOrJoinFarm] error", e);
      res.status(400).json({ error: e?.message || String(e) });
    }
  })
);

/** -------------- createHarvest (schema-exact) -------------- */
export const createHarvest = onRequest(
  { region: "asia-southeast1" },
  withCors( async (req, res) => {
    try {
      if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
      await requireUID(req);

      // body must match Excel schema
      const b = (req.body || {}) as any;
      const farmId = String(b.farmId || "");
      if (!farmId) { res.status(400).json({ error: "missing farmId" }); return; }

      const sidIn = String(b.sid || "").trim();
      const pidIn = String(b.pid || "").trim();

      // tids can be string or array; normalize to array of strings
      let tidsArr: string[] = [];
      if (Array.isArray(b.tids)) {
        tidsArr = b.tids.map((x:any)=>String(x).trim()).filter(Boolean);
      } else if (b.tids != null) {
        tidsArr = [ String(b.tids).trim() ].filter(Boolean);
      }

      // harvest_date: allow ISO string or number (ms)
      const hdRaw = b.harvest_date;
      let harvest_date: FirebaseFirestore.Timestamp | null = null;
      if (typeof hdRaw === "string" && hdRaw.trim()) {
        const d = new Date(hdRaw);
        if (!isNaN(d.getTime())) harvest_date = admin.firestore.Timestamp.fromDate(d);
      } else if (typeof hdRaw === "number" && isFinite(hdRaw)) {
        harvest_date = admin.firestore.Timestamp.fromMillis(hdRaw);
      }
      if (!harvest_date) {
        res.status(400).json({ error: "invalid harvest_date" }); return;
      }

      const capacity = (b.harvesrt_capacity != null) ? Number(b.harvesrt_capacity) : NaN;
      if (!isFinite(capacity)) {
        res.status(400).json({ error: "invalid harvesrt_capacity" }); return;
      }

      // generate HID
      const hnum = await nextCounter(farmId, "harvest");
      const hid = `H${PAD2(hnum)}`;

      const doc = {
        hid,
        sid: sidIn || null,
        pid: pidIn || null,
        tids: tidsArr,
        harvest_date,
        harvesrt_capacity: capacity,
      };
      await db.doc(`farms/${farmId}/harvests/${hid}`).set(doc);

      res.json({ ok:true, hid, item: doc });
    } catch (e:any) {
      console.error("[createHarvest] error", e);
      res.status(400).json({ error: e?.message || String(e) });
    }
  })
);

/** -------------- list harvests (schema-exact) -------------- */
export const harvests = onRequest(
  { region: "asia-southeast1" },
  withCors( async (req, res) => {
    try {
      await requireUID(req);
      const farmId = String(req.query.farmId || "");
      const limit = Math.min(200, Number(req.query.limit || 50));
      if (!farmId) { res.status(400).json({ error: "missing farmId" }); return; }

      const hs = await db.collection(`farms/${farmId}/harvests`).orderBy("harvest_date","desc").limit(limit).get();
      const items = hs.docs.map(d => {
        const x = (d.data() as any) || {};
        return {
          hid: x.hid ?? d.id,
          tids: x.tids ?? [],
          pid: x.pid ?? null,
          sid: x.sid ?? null,
          harvest_date: x.harvest_date || null,
          harvesrt_capacity: x.harvesrt_capacity ?? null,
        };
      });
      res.json({ ok:true, items });
    } catch (e:any) {
      console.error("[harvests] error", e);
      res.status(400).json({ error: e?.message || String(e) });
    }
  })
);

