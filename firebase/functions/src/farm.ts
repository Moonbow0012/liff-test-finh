// functions/src/farm.ts
// Node.js 20, Firebase Functions v2 (asia-southeast1)

import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

try { admin.initializeApp(); } catch { /* ignore double init */ }
const db = admin.firestore();

/* ----------------------------- CORS helpers ----------------------------- */
const ALLOWED_ORIGINS = new Set<string>([
  "https://liff-test-finh.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function setCors(req: any, res: any) {
  const origin = req.headers.origin as string | undefined;
  // โหมดปลอดภัย-เปิด (เพราะไม่ใช้ credentials). ถ้าจะล็อกจริง ๆ ค่อยเปิดบรรทัด has(origin)
  res.set("Access-Control-Allow-Origin", origin && ALLOWED_ORIGINS.has(origin) ? origin : "*");
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-line-id-token, x-line-access-token, authorization, x-dev-uid");
  res.set("Access-Control-Max-Age", "86400");
  res.set("X-Finh-Version", "farm.ts@" + new Date().toISOString());
}
function withCors(
  handler: (req: any, res: any) => Promise<void> | void
) {
  return async (req: any, res: any) => {
    setCors(req, res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    await handler(req, res);
  };
}

/* --------------- Helpers --------------- */
function tsToIso(x: any): string | null {
  if (!x) return null;
  try {
    if (typeof x.toDate === "function") return x.toDate().toISOString();
    if (typeof x._seconds === "number") {
      const ms = x._seconds * 1000 + Math.floor((x._nanoseconds || 0) / 1e6);
      return new Date(ms).toISOString();
    }
    if (typeof x === "string") return x;
    return null;
  } catch { return null; }
}

// Auth (ช่วงแรกใช้ header ชื่อ x-dev-uid; ภายหลังย้ายเป็น verify LINE ID token/Firebase)
async function requireUID(req: any): Promise<string> {
  const dev = req.headers["x-dev-uid"];
  if (typeof dev === "string" && dev.trim()) return dev.trim();
  return "dev-user";
}

async function getMyFarmFor(uid: string) {
  // ใช้ members subcollection ใต้ farms
  const mem = await db.collectionGroup("members").where("uid", "==", uid).limit(1).get();
  if (mem.empty) return null;
  const farmRef = mem.docs[0].ref.parent.parent!;
  const doc = await farmRef.get();
  const raw = doc.data() || {};
  const out: any = { id: farmRef.id, ...raw };
  out.createdAtIso = tsToIso(raw.createdAt);
  out.updatedAtIso = tsToIso(raw.updatedAt);
  delete out.createdAt; delete out.updatedAt;
  return out;
}

/* -------------------------- POST /createOrJoinFarm -------------------------- */
export const createOrJoinFarm = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    try {
      const uid = String(req.get("x-dev-uid") || "").trim() || "dev-user";
      const { name, lat, lng, address } = (req.body || {});
      const LAT = Number(lat), LNG = Number(lng);
      if (!name || !Number.isFinite(LAT) || !Number.isFinite(LNG)) {
        res.status(400).json({ error: "invalid name/lat/lng" }); return;
      }

      // มีฟาร์มอยู่แล้ว? → คืนกลับ
      const mine = await getMyFarmFor(uid);
      if (mine) { res.json({ ok: true, farmId: mine.id, farm: mine }); return; }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const nowTs = admin.firestore.Timestamp.now();
      const batch = db.batch();

      // farms/{farmId}
      const farmRef = db.collection("farms").doc();
      const farmId = farmRef.id;
      batch.set(farmRef, {
        name: String(name).trim(),
        location: { lat: LAT, lng: LNG, address: address ?? null },
        createdBy: uid, createdAt: now, updatedAt: now,
      }, { merge: true });

      // farms/{farmId}/members/{uid}
      batch.set(farmRef.collection("members").doc(uid), {
        uid, role: "owner", joinedAt: now, status: "active",
      }, { merge: true });

      // ---------- scaffold: อย่างละ 1 ตัว (top-level) ----------
      // ponds (ตัวอย่าง)
      const pondRef = db.collection("ponds").doc();
      batch.set(pondRef, {
        farmId, code: "POND-A", name: "บ่อ A",
        areaM2: null, status: "active", createdAt: now, updatedAt: now,
      });

      // trays (ตัวอย่าง) — ผูกบ่อ
      const trayRef = db.collection("trays").doc();
      batch.set(trayRef, {
        farmId, pondId: pondRef.id, code: "TRAY-01",
        capacity: null, status: "idle", createdAt: now, updatedAt: now,
      });

      // crops (ตัวอย่าง) — ผูกถาด, ชนิด “ผำ”, ยังไม่ปลูก
      const cropRef = db.collection("crops").doc();
      batch.set(cropRef, {
        farmId, trayId: trayRef.id,
        species: "ผำ",
        plantedAt: null, status: "idle",
        createdAt: now, updatedAt: now,
      });

      // ---------- scaffold (nested) : farms/{farmId}/harvests ----------
      // สร้างเอกสาร harvest ตัวอย่าง 1 รายการเพื่อให้ตารางหน้าเว็บมีข้อมูลทันที
      const hvRef = farmRef.collection("harvests").doc();
      batch.set(hvRef, {
        date: now,              // ใช้ field 'date' ให้เข้ากับโค้ดหน้าเว็บ
        weightKg: null,
        moisture: null,
        qcResult: null,
        note: "Initial scaffold",
        operatorUid: uid,
        createdAt: now, updatedAt: now,
      });

      // หมายเหตุ: **ไม่**สร้าง harvest_crops ตามที่ร้องขอ

      await batch.commit();

      // อ่านกลับเพื่อแปลง Timestamp เป็น *Iso
      const snap = await farmRef.get();
      const raw = snap.data() || {};
      const farmOut: any = { id: farmId, ...raw };
      farmOut.createdAtIso = tsToIso(raw.createdAt);
      farmOut.updatedAtIso = tsToIso(raw.updatedAt);
      delete farmOut.createdAt; delete farmOut.updatedAt;

      res.json({ ok: true, farmId, farm: farmOut, scaffold: {
        pondId: pondRef.id, trayId: trayRef.id, cropId: cropRef.id, harvestId: hvRef.id, atIso: nowTs.toDate().toISOString()
      }});
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  })
);

/* ------------------------------ GET /myFarm ------------------------------ */
export const myFarm = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    try {
      const uid = String(req.get("x-dev-uid") || "").trim() || "dev-user";
      const farm = await getMyFarmFor(uid);
      res.json({ ok: true, farm: farm || null });
    } catch (e: any) {
      res.json({ ok: false, farm: null, error: e?.message || String(e) });
    }
  })
);

/* ------------------------- GET /harvests?farmId=... ------------------------- */
/**
 * โครงปัจจุบันใช้ path แบบ nested:
 *   farms/{farmId}/harvests
 *   farms/{farmId}/harvest_crops
 *   farms/{farmId}/crops, trays, ponds
 * ถ้าย้ายเป็น table-first (top-level) ให้ปรับ query ให้เหมาะสมในอนาคต
 */
export const harvests = onRequest(
  { region: "asia-southeast1" },
  withCors(async (req, res) => {
    try {
      const farmId = String(req.query.farmId || "");
      const limit = Math.min(200, Number(req.query.limit || 50));
      const includeLineage = String(req.query.includeLineage || "0") === "1";
      if (!farmId) { res.status(400).json({ error: "missing farmId" }); return; }

      const hs = await db.collection(`farms/${farmId}/harvests`)
        .orderBy("date", "desc").limit(limit).get();

      const items: any[] = [];
for (const h of hs.docs) {
  const data = h.data() || {};

  const out: any = {
    id: h.id,
    date: tsToIso(data.date), // ISO string พร้อมใช้ที่หน้าเว็บ
    weightKg: (data.weightKg === undefined || data.weightKg === null) ? null : Number(data.weightKg),
    moisture: (data.moisture === undefined || data.moisture === null) ? null : Number(data.moisture),
    qcResult: (data.qcResult === undefined) ? null : data.qcResult,
    from: null
  };

        if (includeLineage) {
          // สามารถเติม lookup lineage ภายหลังได้
          out.from = null;
        }
        items.push(out);
      }
      res.json({ ok: true, items });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  })
);

/* ------------------------------ GET /pingFirestore ------------------------------ */
export const pingFirestore = onRequest(
  { region: "asia-southeast1" },
  withCors(async (_req, res) => {
    try {
      const ref = db.collection("_diagnostics").doc("ping");
      await ref.set({ at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      const snap = await ref.get();
      res.json({ ok: true, atIso: tsToIso(snap.get("at")) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  })
);

/* ------------------------------ GET /devices ------------------------------ */
/**
 * ส่งรายการอุปกรณ์สำหรับ dropdown บนหน้าเว็บ
 * 1) พยายามอ่านจาก Firestore collection('devices')
 * 2) ถ้าไม่มี/ล้มเหลว fallback ไป Proxy Cloud Run (เดิม)
 */
const PROGRESS_PROXY_URL = "https://getprogress-iyipepekja-as.a.run.app/api/devices";

export const devices = onRequest(
  { region: "asia-southeast1" },
  withCors(async (_req, res) => {
    try {
      const snap = await db.collection("devices").get();
      if (!snap.empty) {
        const devices = snap.docs.map(d => {
          const v = d.data() || {};
          return {
            deviceId: d.id,                       // Firestore docId
            name: v.name || v.deviceId || v.nexiiotDeviceId || d.id,
            nexiiotDeviceId: v.nexiiotDeviceId || null,
            farmId: v.farmId || null,
          };
        });
        res.json({ devices });
        return;
      }
    } catch {
      // ignore and fallback
    }

    // fallback → proxy Cloud Run (เดิม)
    try {
      const r = await fetch(PROGRESS_PROXY_URL, { headers: { "Content-Type": "application/json" } as any });
      const text = await r.text();
      try { res.status(r.status).json(JSON.parse(text)); }
      catch { res.status(r.status).send(text); }
    } catch (e: any) {
      res.status(500).json({ error: "devices_unavailable", detail: String(e?.message || e) });
    }
  })
);
