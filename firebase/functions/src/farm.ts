// firebase/functions/src/farm.ts
// Gen2-only HTTP functions (FLAT layout)
// - SCHEMA_VERSION = 3 (FLAT): farms/{farmId}/{sites|ponds|trays|crops|harvests}
// - FarmId from name-slug (falls back to random). Idempotency supported via x-idempotency-key.
// - Endpoints: createOrJoinFarm, myFarm, structureRows, harvests, createHarvest, migrateFlat

import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp, DocumentReference } from "firebase-admin/firestore";

setGlobalOptions({ region: "asia-southeast1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 10 });

initializeApp();
const db = getFirestore();

// ---------- CORS / helpers ----------
const ALLOWED_ORIGINS = [/https?:\/\/localhost(?::\d+)?$/, /https?:\/\/.*\.vercel\.app$/];
const ALLOW_HEADERS = ["content-type","x-line-access-token","x-line-id-token","x-line-user-id","x-dev-uid","x-idempotency-key"];

function withCors(handler: (req: any, res: any) => Promise<void> | void) {
  return async (req: any, res: any) => {
    const origin = req.headers.origin as string | undefined;
    const ok = origin && ALLOWED_ORIGINS.some((re) => re.test(origin));
    if (ok && origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS.join(","));
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (!ok) { res.status(403).json({ error: "CORS_ORIGIN_REJECTED" }); return; }
    try { await handler(req, res); }
    catch (err: any) { console.error("[ERR]", req.method, req.url, err); res.status(500).json({ error: "INTERNAL", message: String(err?.message || err) }); }
  };
}
function requireUid(req: any): string {
  const uid = (req.headers["x-dev-uid"] as string) || (req.headers["x-line-user-id"] as string) || "";
  if (!uid) throw new Error("UNAUTHORIZED_UID_MISSING");
  return uid;
}
function isNonEmptyString(x: any): x is string { return typeof x === "string" && x.trim().length > 0; }
function asNumber(x: any): number | null { if (typeof x === "number" && Number.isFinite(x)) return x; const n = Number(x); return Number.isFinite(n) ? n : null; }
function pad2(n: number) { return String(n).padStart(2, "0"); }

// slugify (รองรับอักษรไทย) → ใช้เป็นส่วนหนึ่งของ farmId
function slugifyName(name: string): string {
  const s = name.trim().replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase().normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$|\//g, "");
  return s || "farm";
}
async function pickUniqueFarmIdFromName(name: string): Promise<string> {
  const base = slugifyName(name).slice(0, 80);
  let candidate = `farm-${base}`;
  for (let i = 0; i < 6; i++) {
    const snap = await db.collection("farms").doc(candidate).get();
    if (!snap.exists) return candidate;
    candidate = `farm-${base}-` + Math.random().toString(36).slice(2, 6);
  }
  return `farm-${base}-${Date.now().toString(36)}`;
}

// ---------- Firestore helpers ----------
const SCHEMA_VERSION = 3; // FLAT
const farmRef = (farmId: string) => db.collection("farms").doc(farmId);
const memberRef = (farmId: string, uid: string) => farmRef(farmId).collection("members").doc(uid);

async function userIsMember(uid: string, farmId: string): Promise<boolean> {
  const snap = await memberRef(farmId, uid).get();
  return snap.exists && snap.get("role") !== "left";
}
async function findFirstFarmForUser(uid: string): Promise<{ farmId: string } | null> {
  try {
    const q = await db.collectionGroup("members").where("userId", "==", uid).limit(1).get();
    if (q.empty) return null;
    const farmId = q.docs[0].ref.parent.parent?.id;
    return farmId ? { farmId } : null;
  } catch { return null; }
}

// ---------- FLAT seed (no nesting, no settings) ----------
async function seedFarmStructureFlat(
  farmId: string,
  name: string,
  ownerUid: string,
  location?: { lat: number; lng: number; address: string }
) {
  const fRef = farmRef(farmId);
  const batch = db.batch();

  batch.set(fRef, { name, slug: slugifyName(name), schemaVersion: SCHEMA_VERSION, updatedAt: FieldValue.serverTimestamp(), ...(location ? { location } : {}) }, { merge: true });

  const sId = `S${pad2(1)}`;
  const pId = `P${pad2(1)}`;
  const tId = `T${pad2(1)}`;

  batch.set(fRef.collection("sites").doc(sId), { sid: sId, sname: "Site 1", location: location || null, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(fRef.collection("ponds").doc(pId), { pid: pId, pname: "Pond 1", sid: sId, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(fRef.collection("trays").doc(tId), { tid: tId, tname: "Tray 1", sid: sId, pid: pId, capacity_kg: 0, createdAt: FieldValue.serverTimestamp() }, { merge: true });

  batch.set(memberRef(farmId, ownerUid), { userId: ownerUid, role: "owner", joinedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
}

// ---------- Endpoints ----------
// POST /createOrJoinFarm
export const createOrJoinFarm = onRequest(withCors(async (req: any, res: any) => {
  if (req.method !== "POST") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }
  let uid: string; try { uid = requireUid(req); } catch { res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const name = isNonEmptyString(body.name) ? body.name.trim() : null;
  const lat = asNumber(body.lat), lng = asNumber(body.lng);
  const address = isNonEmptyString(body.address) ? body.address.trim() : "";
  const idem = (req.headers["x-idempotency-key"] as string) || "";

  if (!name || lat === null || lng === null) { res.status(400).json({ error: "FAILED_PRECONDITION", message: "name, lat, lng required (numbers only)" }); return; }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { res.status(400).json({ error: "INVALID_COORDINATE" }); return; }

  // already has a farm → update + return
  const existing = await findFirstFarmForUser(uid);
  if (existing) {
    const fRef = farmRef(existing.farmId);
    await fRef.set({ name, slug: slugifyName(name), location: { lat, lng, address }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const data = (await fRef.get()).data();
    res.json({ farmId: existing.farmId, farm: data });
    return;
  }

  // new farm id from name (or idempotency key)
  const newRef: DocumentReference = idem
    ? farmRef(`f_${Buffer.from(idem).toString("hex").slice(0, 16)}`)
    : farmRef(await pickUniqueFarmIdFromName(name));

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(newRef);
    if (!snap.exists) {
      tx.set(newRef, { name, slug: slugifyName(name), location: { lat, lng, address }, createdAt: FieldValue.serverTimestamp(), createdBy: uid, schemaVersion: SCHEMA_VERSION });
    } else {
      tx.update(newRef, { name, slug: slugifyName(name), location: { lat, lng, address }, updatedAt: FieldValue.serverTimestamp() });
    }
  });

  await seedFarmStructureFlat(newRef.id, name!, uid, { lat, lng, address });
  const farmDoc = (await newRef.get()).data();
  res.json({ farmId: newRef.id, farm: farmDoc });
}));

export const myFarm = onRequest(withCors(async (req, res) => {
  if (req.method !== "GET") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }
  const uid = requireUid(req);
  const soft = String(req.query.soft || "") === "1";

  const found = await findFirstFarmForUser(uid);
  if (!found) { soft ? res.json({ hasFarm:false }) : res.status(404).json({ error:"NO_FARM" }); return; }

  const fSnap = await farmRef(found.farmId).get();
  if (!fSnap.exists) { soft ? res.json({ hasFarm:false }) : res.status(404).json({ error:"FARM_NOT_FOUND" }); return; }

  res.json({ hasFarm:true, farmId: found.farmId, farm: fSnap.data() });
}));

async function getLatestHarvestForTray(farmId: string, tid: string) {
  const q = await db
    .collection(`farms/${farmId}/harvests`)
    .where("tids", "array-contains", tid)
    .orderBy("harvest_date", "desc")
    .limit(1)
    .get();

  if (q.empty) return null;
  const d = q.docs[0];
  return { id: d.id, ...d.data() };
}

// GET /structureRows?farmId=...&includeHarvest=1
export const structureRows = onRequest(withCors(async (req: any, res: any) => {
  if (req.method !== "GET") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }
  let uid: string; try { uid = requireUid(req); } catch { res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" }); return; }
  const farmId = String(req.query.farmId || ""); const includeHarvest = String(req.query.includeHarvest || "0") === "1";
  if (!isNonEmptyString(farmId)) { res.status(400).json({ error: "MISSING_FARM_ID" }); return; }
  if (!(await userIsMember(uid, farmId))) { res.status(403).json({ error: "NOT_MEMBER" }); return; }

  const fRef = farmRef(farmId);
  const [sitesSnap, pondsSnap, traysSnap, cropsSnap] = await Promise.all([
    fRef.collection("sites").get(),
    fRef.collection("ponds").get(),
    fRef.collection("trays").get(),
    fRef.collection("crops").get().catch(() => ({ empty: true, docs: [] })) as any,
  ]);

const siteById = new Map<string, any>();
for (const d of sitesSnap.docs) {
  const v: any = { id: d.id, ...(d.data() as any) };
  siteById.set(v.sid ?? d.id, v);
}
  const pondById = new Map<string, any>();
for (const d of pondsSnap.docs) {
  const v: any = { id: d.id, ...(d.data() as any) };
  pondById.set(v.pid ?? d.id, v);
}
  const cropsByTid = new Map<string, any[]>(); for (const d of (cropsSnap.docs || [])) { const v: any = { id: d.id, ...d.data() }; const tid = v.tid || v.trayId; if (!tid) continue; (cropsByTid.get(tid) || cropsByTid.set(tid, []).get(tid)!).push(v); }

  const rows: any[] = [];
  for (const d of traysSnap.docs) {
    const T: any = { id: d.id, ...d.data() };
    const tid = T.tid || T.id, pid = T.pid || T.pondId, sid = T.sid || T.siteId;
    const S = sid ? siteById.get(sid) : null; const P = pid ? pondById.get(pid) : null;
    const row: any = {
      sid, sname: S?.sname || S?.name || "",
      pid, pname: P?.pname || P?.name || "",
      tid, tname: T.tname || T.name || "",
      crops: cropsByTid.get(tid) || [],
      latestHarvest: null as any,
    };
    if (includeHarvest && tid) row.latestHarvest = await getLatestHarvestForTray(farmId, tid);
    rows.push(row);
  }

  rows.sort((a, b) => (a.sid||"").localeCompare(b.sid||"") || (a.pid||"").localeCompare(b.pid||"") || (a.tid||"").localeCompare(b.tid||""));
  res.json({ farmId, rows });
}));

// GET /harvests?farmId=...&limit=100
export const harvests = onRequest(withCors(async (req: any, res: any) => {
  if (req.method !== "GET") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }
  let uid: string; try { uid = requireUid(req); } catch { res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" }); return; }
  const farmId = String(req.query.farmId || ""); if (!isNonEmptyString(farmId)) { res.status(400).json({ error: "MISSING_FARM_ID" }); return; }
  if (!(await userIsMember(uid, farmId))) { res.status(403).json({ error: "NOT_MEMBER" }); return; }
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const snaps = await db.collection(`farms/${farmId}/harvests`).orderBy("harvest_date", "desc").limit(limit).get();
  const items = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  res.json({ farmId, items });
}));

// POST /createHarvest { farmId, tids[], harvesrt_capacity, harvest_date?, note? }
export const createHarvest = onRequest(withCors(async (req: any, res: any) => {
  if (req.method !== "POST") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }
  let uid: string; try { uid = requireUid(req); } catch { res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const farmId = isNonEmptyString(body.farmId) ? body.farmId : "";
  if (!farmId || !(await userIsMember(uid, farmId))) { res.status(403).json({ error: "NOT_MEMBER" }); return; }

  const tids: string[] = Array.isArray(body.tids) ? body.tids.filter((s: any) => isNonEmptyString(s)) : (isNonEmptyString(body.trayId) ? [body.trayId] : []);
  const harvest_capacity = (asNumber(body.harvesrt_capacity) ?? asNumber(body.weight));
  const harvest_date = body.harvest_date ? new Date(body.harvest_date) : (body.ts ? new Date(body.ts) : new Date());
  const note = isNonEmptyString(body.note) ? body.note : "";
  const idem = (req.headers["x-idempotency-key"] as string) || "";

  if (!tids.length || harvest_capacity === null) { res.status(400).json({ error: "FAILED_PRECONDITION", message: "tids[] and numeric harvesrt_capacity required" }); return; }

  const hRef = idem
    ? db.collection(`farms/${farmId}/harvests`).doc(`h_${Buffer.from(idem).toString("hex").slice(0, 16)}`)
    : db.collection(`farms/${farmId}/harvests`).doc();

  await db.runTransaction(async (tx) => {
    const exists = await tx.get(hRef);
    if (exists.exists) return;
    tx.set(hRef, { hid: hRef.id, tids, harvesrt_capacity: harvest_capacity, harvest_date: Timestamp.fromDate(harvest_date), note, createdBy: uid, createdAt: FieldValue.serverTimestamp(), status: "completed" });
  });

  const doc = await hRef.get();
  res.json({ id: hRef.id, ...doc.data() });
}));

// POST /migrateFlat { farmId, apply?: 1 }  // copy nested → flat (dry-run by default)
export const migrateFlat = onRequest(withCors(async (req: any, res: any) => {
  if (req.method !== "POST") { res.status(405).json({ error: "METHOD_NOT_ALLOWED" }); return; }
  let uid: string; try { uid = requireUid(req); } catch { res.status(401).json({ error: "UNAUTHORIZED_UID_MISSING" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const farmId = isNonEmptyString(body.farmId) ? body.farmId : String(req.query.farmId || "");
  const apply = String(body.apply ?? req.query.apply ?? "0") === "1";
  if (!isNonEmptyString(farmId)) { res.status(400).json({ error: "MISSING_FARM_ID" }); return; }
  if (!(await userIsMember(uid, farmId))) { res.status(403).json({ error: "NOT_MEMBER" }); return; }

  const fRef = farmRef(farmId);
  const sitesSnap = await fRef.collection("sites").get();
  const plan: any = { ponds: [], trays: [] };

  for (const s of sitesSnap.docs) {
    const sid = s.get("sid") || s.id;
    const pondsSnap = await s.ref.collection("ponds").get();
    for (const p of pondsSnap.docs) {
      const pid = p.get("pid") || p.id;
      plan.ponds.push({ pid, sid, data: { ...p.data(), sid } });
      const traysSnap = await p.ref.collection("trays").get();
      for (const t of traysSnap.docs) {
        const tid = t.get("tid") || t.id;
        plan.trays.push({ tid, pid, sid, data: { ...t.data(), pid, sid } });
      }
    }
  }

  if (!apply) { res.json({ dryRun: true, counts: { ponds: plan.ponds.length, trays: plan.trays.length }, sample: { pond: plan.ponds[0] || null, tray: plan.trays[0] || null } }); return; }

  const batch = db.batch();
  for (const p of plan.ponds) batch.set(fRef.collection("ponds").doc(p.pid), { ...p.data, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  for (const t of plan.trays) batch.set(fRef.collection("trays").doc(t.tid), { ...t.data, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();

  res.json({ applied: true, migrated: { ponds: plan.ponds.length, trays: plan.trays.length } });
}));

// index.ts: export { createOrJoinFarm, myFarm, structureRows, harvests, createHarvest, migrateFlat } from "./farm";
