// firebase/functions/src/index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import type { Request, Response } from "express";

admin.initializeApp();
const db = admin.firestore();

// ===== ENV / Secrets =====
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || "https://auth.nexiiot.io/oauth/token";
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const SERVICE_USERNAME = process.env.SERVICE_USERNAME;
const SERVICE_PASSWORD = process.env.SERVICE_PASSWORD;
const NX_GRAPHQL_URL = process.env.NX_GRAPHQL_URL || "https://gqlv2.nexiiot.io/graphql";

// ===== Helpers =====
function setCors(res: Response) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function inRange(v: any, range?: { min?: number; max?: number }) {
  if (v == null || typeof v !== "number") return false;
  const { min, max } = range || {};
  if (typeof min === "number" && v < min) return false;
  if (typeof max === "number" && v > max) return false;
  return true;
}

function levelFromPercent(p: number) {
  if (p >= 100) return "L4";
  if (p >= 75) return "L3";
  if (p >= 50) return "L2";
  if (p >= 25) return "L1";
  return "L0";
}

async function getNexiiotAccessToken(): Promise<string> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !SERVICE_USERNAME || !SERVICE_PASSWORD) {
    throw new Error("Missing NexIIoT OAuth env");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "password");
  body.set("username", SERVICE_USERNAME);
  body.set("password", SERVICE_PASSWORD);

  const basic = "Basic " + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString("base64");
  const fetchAny: any = (globalThis as any).fetch;
  const r = await fetchAny(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
    body: body.toString(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "oauth failed");
  return j.access_token as string;
}

const SHADOW_QUERY = `
  query($deviceid:String!){
    shadow(deviceid:$deviceid){ deviceid data modified }
  }
`;

async function computeOneDevice(deviceDoc: admin.firestore.DocumentSnapshot, accessToken: string) {
  const deviceId = deviceDoc.id;
  const cfg = (deviceDoc.data() || {}) as any;
  const nxId = cfg.nexiiotDeviceId || deviceId;
  const map = cfg.variableMap || {}; // ex. { light:"Light_out", moisture:"Soil_moisture" }
  const th = cfg.thresholds || {}; // keys to check AND
  const windowMin = cfg.windowMinutes || 60;

  const fetchAny: any = (globalThis as any).fetch;
  const r = await fetchAny(NX_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
    body: JSON.stringify({ query: SHADOW_QUERY, variables: { deviceid: nxId } }),
  });
  const text = await r.text();
  let gql: any;
  try {
    gql = JSON.parse(text);
  } catch {
    throw new Error(`GQL parse error: ${text}`);
  }
  if (!r.ok || gql.errors) throw new Error(JSON.stringify(gql.errors || text));

  const shadow = gql?.data?.shadow;
  if (!shadow) throw new Error("shadow not found");
  const raw = shadow.data || {};

  const values: Record<string, any> = {};
  let good = true;
  for (const key of Object.keys(th)) {
    const realKey = map[key];
    const val = raw[realKey];
    values[key] = val;
    if (!inRange(val, th[key])) good = false;
  }

  const ref = db.collection("progress").doc(deviceId);
  const snap = await ref.get();
  const prog = snap.exists ? (snap.data() as any) : {};
  let goodSince: Date | null = prog.goodSince
    ? prog.goodSince.toDate
      ? prog.goodSince.toDate()
      : new Date(prog.goodSince)
    : null;
  let percent = typeof prog.percent === "number" ? prog.percent : 0;

  const now = new Date();
  const windowMs = (windowMin || 60) * 60 * 1000;

  if (good) {
    if (!goodSince) goodSince = now;
    percent = Math.max(0, Math.min(100, ((+now - +goodSince) / windowMs) * 100));
  } else {
    goodSince = null;
    percent = 0;
  }

  const level = levelFromPercent(percent);

  await ref.set(
    {
      deviceId,
      goodNow: good,
      goodSince: goodSince ? admin.firestore.Timestamp.fromDate(goodSince) : null,
      percent: Math.round(percent * 100) / 100,
      level,
      lastValues: values,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { deviceId, percent, level, good, values };
}

// ===== 1) Scheduler (v2): ทุก 5 นาที =====
export const pollNexiiot = onSchedule("every 5 minutes", async () => {
  const token = await getNexiiotAccessToken();
  const snap = await db.collection("devices").get();
  const tasks: Promise<any>[] = [];
  snap.forEach((doc) => {
    tasks.push(
      computeOneDevice(doc, token).catch((e) => ({ deviceId: doc.id, error: (e as Error).message }))
    );
  });
  const results = await Promise.all(tasks);
  console.log("poll results:", results);
});

// ===== 2) HTTP (v2): อ่านผลล่าสุด =====
export const getProgress = onRequest(async (req: Request, res: Response): Promise<void> => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const deviceId = (req.query.deviceId || req.query.deviceid) as string | undefined;
  if (!deviceId) {
    res.status(400).json({ error: "deviceId required" });
    return;
  }
  const snap = await db.collection("progress").doc(String(deviceId)).get();
  if (!snap.exists) {
    res.status(404).json({ error: "progress not found" });
    return;
  }
  res.status(200).json(snap.data());
});

// ===== 3) HTTP (v2): seed config 2 ฟาร์มของคุณ (เรียกครั้งเดียว) =====
export const seedConfig = onRequest(async (req: Request, res: Response): Promise<void> => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const batch = db.batch();

  batch.set(db.collection("devices").doc("20b1b470-a0b4-412a-890d-fa87380183c6"), {
    nexiiotDeviceId: "20b1b470-a0b4-412a-890d-fa87380183c6",
    variableMap: { light: "Light_out", moisture: "Soil_moisture" },
    thresholds: { light: { min: 300, max: 1200 }, moisture: { min: 35, max: 60 } },
    windowMinutes: 60,
  }, { merge: true });

  batch.set(db.collection("devices").doc("3e3fe3eb-7677-4585-bd02-fb4b53793a33"), {
    nexiiotDeviceId: "3e3fe3eb-7677-4585-bd02-fb4b53793a33",
    variableMap: { light: "Weather_light_par", temp: "Weather_Temperature" },
    thresholds: { light: { min: 200, max: 1500 }, temp: { min: 20, max: 35 } },
    windowMinutes: 60,
  }, { merge: true });

  await batch.commit();
  res.status(200).json({ ok: true });
});
