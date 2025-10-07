// functions/src/tracking.ts
import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const _admin: any = admin || {};
if (!_admin.apps || !_admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ===== CORS helper (อนุญาต Vercel + localhost) ===== */
const ALLOWED_ORIGINS = new Set([
  "https://liff-test-finh.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function setCors(req: any, res: any) {
  const origin = req.headers.origin;
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";
  res.set("Access-Control-Allow-Origin", allow);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // เพิ่ม header ที่เราส่งจากหน้าเว็บ (สำคัญมาก)
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, x-line-id-token, x-line-access-token, authorization"
  );
  res.set("Access-Control-Max-Age", "86400");
}

function withCors(
  handler: (req: any, res: any) => void | Promise<void>
) {
  return async (req: any, res: any) => {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).send(""); // ตอบ preflight
      return;
    }
    await handler(req, res);
  };
}

async function requireUID(req: any): Promise<string> {
  // ตัวอย่าง dev: ให้ผ่านไปก่อน
  const dev = req.headers["x-dev-uid"];
  if (typeof dev === "string" && dev) return dev;
  return "dev-user";
}

/** ตรวจว่าผู้ใช้เป็นสมาชิกฟาร์มหรือยัง
 *  NOTE: โครงนี้เก็บ membership ใต้ farms/{farmId}/members/{uid} พร้อม field { uid, role }
 */
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

/** สร้าง/เข้าร่วมฟาร์ม (เด้งฟอร์มครั้งแรก) */
export const createOrJoinFarm = onRequest(
  { region: "asia-southeast1", cors: true },
  async (req, res) => {
    try {
      const uid = await requireUID(req);
      const { name, lat, lng, address } = (req.body || {}) as {
        name?: string;
        lat?: number;
        lng?: number;
        address?: string | null;
      };

      // ถ้ามีฟาร์มอยู่แล้ว -> ส่งฟาร์มเดิมกลับ
      const existing = await getMyFarmFor(uid);
      if (existing) {
        res.json({ ok: true, farmId: existing.id, farm: existing });
        return;
      }

      if (!name || typeof lat !== "number" || typeof lng !== "number") {
        res.status(400).json({ error: "missing name/lat/lng" });
        return;
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const farmRef = db.collection("farms").doc();
      await farmRef.set({
        name,
        location: { lat, lng, address: address || null },
        createdBy: uid,
        createdAt: now,
        membersCount: 1,
      });
      await farmRef.collection("members").doc(uid).set({
        uid,
        role: "owner",
        joinedAt: now,
      });

      const farmDoc = await farmRef.get();
      res.json({ ok: true, farmId: farmRef.id, farm: { id: farmRef.id, ...(farmDoc.data() || {}) } });
      return;
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  }
);

/** ดึงฟาร์มของฉัน (ใช้เช็คว่า onboarding แล้วหรือยัง) */
export const myFarm = onRequest(
  { region: "asia-southeast1", cors: true },
  async (req, res) => {
    try {
      const uid = await requireUID(req);
      const farm = await getMyFarmFor(uid);
      res.json({ farm });
      return;
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  }
);

/** คืนรายการ Harvest + lineage แบบย่อย ๆ สำหรับการ์ด Tracking */
export const harvests = onRequest(
  { region: "asia-southeast1", cors: true },
  async (req, res) => {
    try {
      // ปกติควรเช็ค uid และสิทธิ์ดู farm นี้ด้วย
      await requireUID(req);

      const farmId = String(req.query.farmId || "");
      const limit = Math.min(200, Number(req.query.limit || 50));
      if (!farmId) {
        res.status(400).json({ error: "missing farmId" });
        return;
      }

      // อ่าน harvests: farms/{farmId}/harvests (คาดว่ามี field date: Timestamp)
      const hs = await db
        .collection(`farms/${farmId}/harvests`)
        .orderBy("date", "desc")
        .limit(limit)
        .get();

      const items: any[] = [];
      for (const h of hs.docs) {
        const hvData = (h.data() as any) || {};
        const hv = { id: h.id, ...hvData };

        // lineage จาก pivot: farms/{farmId}/harvest_crops (cropId หลายตัว)
        const piv = await db
          .collection(`farms/${farmId}/harvest_crops`)
          .where("harvestId", "==", h.id)
          .get();

        const cropIds = piv.docs.map((d) => (d.data() as any).cropId).filter(Boolean);
        let from: any = null;

        if (cropIds.length) {
          // หาตัวอย่างหนึ่ง crop เพื่อขึ้นชื่อ tray/pond (เอา code ถ้ามี ไม่งั้นใช้ id)
          const cdoc = await db.doc(`farms/${farmId}/crops/${cropIds[0]}`).get();
          const crop = cdoc.exists ? ({ id: cdoc.id, ...(cdoc.data() as any) }) : null;

          let tray: string | null = null;
          let pond: string | null = null;

          if (crop) {
            if (crop.trayId) {
              const tdoc = await db.doc(`farms/${farmId}/trays/${crop.trayId}`).get();
              if (tdoc.exists) {
                const t = tdoc.data() as any;
                tray = t?.code || tdoc.id;
              }
            }
            if (crop.pondId) {
              const pdoc = await db.doc(`farms/${farmId}/ponds/${crop.pondId}`).get();
              if (pdoc.exists) {
                const p = pdoc.data() as any;
                pond = p?.code || pdoc.id;
              }
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

      res.json({ items });
      return;
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  }
);
