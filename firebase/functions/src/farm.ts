// firebase/functions/src/farm.ts
// Gen2-only HTTP functions for LIFF-Farm-Tracking
// - Region: asia-southeast1
// - Everything under farms/{farmId}
// - SchemaVersion = 2 with seed of sites/S01/ponds/P01/trays/T01
// - Safe CORS + clear error messages (no silent 500s)
// - Keep handler params untyped (any) to avoid Express type mismatch issues

import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  FieldValue,
  Timestamp,
  DocumentReference,
} from "firebase-admin/firestore";

setGlobalOptions({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 10,
});

initializeApp();
const db = getFirestore();

// ------------------------
// CORS + helpers
// ------------------------
const ALLOWED_ORIGINS = [
  /https?:\/\/localhost(?::\d+)?$/,
  /https?:\/\/.*\.vercel\.app$/,
];
const ALLOW_HEADERS = [
  "content-type",
  "x-line-access-token",
  "x-line-id-token",
  "x-line-user-id",
  "x-dev-uid",
  "x-idempotency-key",
];

function withCors(handler: (req: any, res: any) => Promise<void> | void) {
  return async (req: any, res: any) => {
    const origin = req.headers.origin as string | undefined;
    const ok = origin && ALLOWED_ORIGINS.some((re) => re.test(origin));

    if (ok && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS.join(","));
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (!ok) {
      res.status(403).json({ error: "CORS_ORIGIN_REJECTED" });
      return;
    }

    try {
      await handler(req, res);
    } catch (err: any) {
      console.error("[ERR]", req.method, req.url, { uid: req.headers["x-dev-uid"] }, err);
      res
        .status(500)
        .json({ error: "INTERNAL", message: String(err?.message || err) });
    }
  };
}

function requireUid(req: any): string {
  const uid =
    (req.headers["x-dev-uid"] as string) ||
    (req.headers["x-line-user-id"] as string) ||
    "";
  if (!uid) throw new Error("UNAUTHORIZED_UID_MISSING");
  return uid;
}

function isNonEmptyString(x: any): x is string {
  return typeof x === "string" && x.trim().length > 0;
}
function asNumber(x: any): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function code2(n: number) {
  return String(n).padStart(2, "0");
}

// ------------------------
// Firestore schema helpers
// ------------------------
const SCHEMA_VERSION = 2;
function farmRef(farmId: string) {
  return db.collection("farms").doc(farmId);
}
function memberRef(farmId: string, uid: string) {
  return farmRef(farmId).collection("members").doc(uid);
}

async function userIsMember(uid: string, farmId: string): Promise<boolean> {
  const snap = await memberRef(farmId, uid).get();
  return snap.exists && snap.get("role") !== "left";
}

async function findFirstFarmForUser(
  uid: string
): Promise<{ farmId: string } | null> {
  try {
    const q = await db
      .collectionGroup("members")
      .where("userId", "==", uid)
      .limit(1)
      .get();
    if (q.empty) return null;
    const farmId = q.docs[0].ref.parent.parent?.id;
    return farmId ? { farmId } : null;
  } catch (e) {
    console.warn("collectionGroup members lookup failed", e);
    return null;
  }
}

// Seed V2 layout under farms/{farmId}
async function seedFarmStructureV2(
  farmId: string,
  name: string,
  ownerUid: string,
  location?: { lat: number; lng: number; address: string }
) {
  const fRef = farmRef(farmId);
  const batch = db.batch();

  batch.set(
    fRef,
    {
      name,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: FieldValue.serverTimestamp(),
      ...(location ? { location } : {}),
    },
    { merge: true }
  );

  // settings/general defaults
  batch.set(
    fRef.collection("settings").doc("general"),
    {
      KPI_WEIGHT_LIGHT: 0.5,
      KPI_WEIGHT_EC: 0.5,
      LIGHT_TARGET: 1000,
      SOIL_EC_TARGET: 2.0,
      TEMP_THRESHOLD: 35,
      TEMP_DELTA: 3,
      TEMP_INTERVAL_MINUTES: 30,
      LEVEL_BOUNDS: [0, 25, 50, 75, 100],
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // sites/S01 -> ponds/P01 -> trays/T01
  const sId = `S${code2(1)}`;
  const pId = `P${code2(1)}`;
  const tId = `T${code2(1)}`;
  const siteRef = fRef.collection("sites").doc(sId);
  const pondRef = siteRef.collection("ponds").doc(pId);
  const trayRef = pondRef.collection("trays").doc(tId);

  batch.set(
    siteRef,
    {
      sid: sId,
      sname: "Site 1",
      area_m2: 0,
      sum_capacity: 0,
      wtype: "pond",
      location: location || null,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  batch.set(
    pondRef,
    {
      pid: pId,
      pname: "Pond 1",
      sid: sId,
      sum_capacity_kg: 0,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  batch.set(
    trayRef,
    {
      tid: tId,
      sid: sId,
      pid: pId,
      name: "Tray 1",
      capacity_kg: 0,
      sum_capacity: 0,
      sum_havest: 0,
      act_harvest: false,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // owner membership
  batch.set(
    memberRef(farmId, ownerUid),
    { userId: ownerUid, role: "owner", joinedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  await batch.commit();
}

// ------------------------
// Handlers (Gen2)
// ------------------------
export const createOrJoinFarm = onRequest(
  withCors(async (req: any, res: any) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    let uid: string;
    try {
      uid = requireUid(req);
    } catch {
      res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" });
      return;
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const name = isNonEmptyString(body.name) ? body.name.trim() : null;
    const lat = asNumber(body.lat);
    const lng = asNumber(body.lng);
    const address = isNonEmptyString(body.address) ? body.address.trim() : "";
    const idempotencyKey = (req.headers["x-idempotency-key"] as string) || "";

    if (!name || lat === null || lng === null) {
      res.status(400).json({
        error: "FAILED_PRECONDITION",
        message: "name, lat, lng required (numbers only)",
      });
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: "INVALID_COORDINATE" });
      return;
    }

    // If already member of a farm, update name/location and return idempotently
    const existing = await findFirstFarmForUser(uid);
    if (existing) {
      const fRef = farmRef(existing.farmId);
      await fRef.set(
        {
          name,
          location: { lat, lng, address },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      const data = (await fRef.get()).data();
      res.json({ farmId: existing.farmId, farm: data });
      return;
    }

    // Create new farm (deterministic id if idempotency key provided)
    const newRef: DocumentReference = idempotencyKey
      ? farmRef(`f_${Buffer.from(idempotencyKey).toString("hex").slice(0, 16)}`)
      : farmRef(db.collection("farms").doc().id);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(newRef);
      if (!snap.exists) {
        tx.set(newRef, {
          name,
          location: { lat, lng, address },
          createdAt: FieldValue.serverTimestamp(),
          createdBy: uid,
          schemaVersion: SCHEMA_VERSION,
        });
      } else {
        tx.update(newRef, {
          name,
          location: { lat, lng, address },
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });

    await seedFarmStructureV2(newRef.id, name!, uid, { lat, lng, address });
    const farmDoc = (await newRef.get()).data();
    res.json({ farmId: newRef.id, farm: farmDoc });
  })
);

export const myFarm = onRequest(withCors(async (req: any, res: any) => {
  if (req.method !== "GET") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }

  let uid: string;
  try { uid = requireUid(req); }
  catch { res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" }); return; }

  const soft = String(req.query.soft || "") === "1";   // ← เพิ่มโหมด soft

  const found = await findFirstFarmForUser(uid);
  if (!found) {
    if (soft) { res.json({ hasFarm: false }); return; } // ← 200 แทน 404
    res.status(404).json({ error: "NO_FARM" }); return;
  }

  const fSnap = await farmRef(found.farmId).get();
  if (!fSnap.exists) {
    if (soft) { res.json({ hasFarm: false }); return; }
    res.status(404).json({ error: "FARM_NOT_FOUND" }); return;
  }

  res.json({ hasFarm: true, farmId: found.farmId, farm: fSnap.data() });
}));


export const harvests = onRequest(
  withCors(async (req: any, res: any) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    let uid: string;
    try {
      uid = requireUid(req);
    } catch {
      res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" });
      return;
    }

    const farmId = String(req.query.farmId || "");
    if (!isNonEmptyString(farmId)) {
      res.status(400).json({ error: "MISSING_FARM_ID" });
      return;
    }
    if (!(await userIsMember(uid, farmId))) {
      res.status(403).json({ error: "NOT_MEMBER" });
      return;
    }

    const limit = Math.min(Number(req.query.limit || 100), 500);
    const snaps = await db
      .collection(`farms/${farmId}/harvests`)
      .orderBy("harvest_date", "desc") // schema V2
      .limit(limit)
      .get();

    const items = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ farmId, items });
  })
);

export const createHarvest = onRequest(
  withCors(async (req: any, res: any) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    let uid: string;
    try {
      uid = requireUid(req);
    } catch {
      res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" });
      return;
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const farmId = isNonEmptyString(body.farmId) ? body.farmId : "";
    if (!farmId || !(await userIsMember(uid, farmId))) {
      res.status(403).json({ error: "NOT_MEMBER" });
      return;
    }

    // Support old payload (weight/trayId/ts) and new schema (harvesrt_capacity/tids/harvest_date)
    const tids: string[] = Array.isArray(body.tids)
      ? body.tids.filter((s: any) => isNonEmptyString(s))
      : isNonEmptyString(body.trayId)
      ? [body.trayId]
      : [];
    const harvest_capacity = asNumber(body.harvesrt_capacity) ?? asNumber(body.weight);
    const harvest_date = body.harvest_date
      ? new Date(body.harvest_date)
      : body.ts
      ? new Date(body.ts)
      : new Date();
    const note = isNonEmptyString(body.note) ? body.note : "";
    const idempotencyKey = (req.headers["x-idempotency-key"] as string) || "";

    if (!tids.length || harvest_capacity === null) {
      res.status(400).json({
        error: "FAILED_PRECONDITION",
        message: "tids[] and numeric harvesrt_capacity required",
      });
      return;
    }

    const hRef = idempotencyKey
      ? db
          .collection(`farms/${farmId}/harvests`)
          .doc(`h_${Buffer.from(idempotencyKey).toString("hex").slice(0, 16)}`)
      : db.collection(`farms/${farmId}/harvests`).doc();

    await db.runTransaction(async (tx) => {
      const exists = await tx.get(hRef);
      if (exists.exists) return; // idempotent
      tx.set(hRef, {
        hid: hRef.id,
        tids,
        harvesrt_capacity: harvest_capacity,
        harvest_date: Timestamp.fromDate(harvest_date),
        note,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
        status: "completed",
      });
    });

    const doc = await hRef.get();
    res.json({ id: hRef.id, ...doc.data() });
  })
);

// End of file
