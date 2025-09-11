// firebase/functions/src/index.ts — Full implementation for pollNexiiot + diagnostics (A & B)
// Node.js 20, Firebase Functions v2, region asia-southeast1
// -----------------------------------------------------------------------------
// WHAT'S INCLUDED
//  - diagSecrets         (HTTP): verify secrets are injected (boolean flags only)
//  - diagToken           (HTTP): test OAuth token exchange with NexIIoT IdP (masked)
//  - diagGraphql         (HTTP): run a lightweight GraphQL query (__typename) via server-side token
//  - getProgress         (HTTP): read computed progress for a device
//  - recomputeOne        (HTTP): compute one device on demand (dryRun supported)
//  - diagPollStatus      (HTTP): last poll status snapshot from Firestore (functions_state/pollNexiiot)
//  - pollNexiiot         (SCHEDULE): poll all devices every 5 minutes, compute & persist progress
//
//  - Robust error handling + per-device logging + Firestore state snapshot
//  - Clear TODOs where you must plug your real GraphQL query to fetch shadow values
// -----------------------------------------------------------------------------

import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import * as admin from "firebase-admin";
import type { Request, Response } from "express";

try { admin.app(); } catch { admin.initializeApp(); }
const db = admin.firestore();

setGlobalOptions({
  region: "asia-southeast1",
  memory: "256MiB",
  timeoutSeconds: 60,
});

// ----------------------------------------------------------------------------
// Secrets
// ----------------------------------------------------------------------------
const OAUTH_CLIENT_ID     = defineSecret("OAUTH_CLIENT_ID");
const OAUTH_CLIENT_SECRET = defineSecret("OAUTH_CLIENT_SECRET");
const SERVICE_USERNAME    = defineSecret("SERVICE_USERNAME");
const SERVICE_PASSWORD    = defineSecret("SERVICE_PASSWORD");
const OAUTH_TOKEN_URL     = defineSecret("OAUTH_TOKEN_URL"); // optional (defaults below)
const NX_GRAPHQL_URL      = defineSecret("NX_GRAPHQL_URL");  // optional (defaults below)

// ----------------------------------------------------------------------------
// Firestore Refs & Types
// ----------------------------------------------------------------------------
const DEVICES_COL = db.collection("devices");
const PROGRESS_COL = db.collection("progress");
const STATE_REF = db.doc("functions_state/pollNexiiot");

type Threshold = { min?: number; max?: number };
type Thresholds = Record<string, Threshold>; // key = logical sensor key (must exist in variableMap)

type DeviceConfig = {
  nexiiotDeviceId?: string;
  variableMap?: Record<string, string>; // logicalKey -> shadowKey (dot-path ok)
  thresholds?: Thresholds;              // logicalKey -> {min,max}
  windowMinutes?: number;               // minutes of continuous "good" required to reach 100%
};

type ProgressDoc = {
  percent: number;
  level: string;
  goodNow: boolean;
  goodSince?: admin.firestore.Timestamp | null;
  lastValues?: Record<string, any>;
  updatedAt: admin.firestore.Timestamp;
};

// ----------------------------------------------------------------------------
// Small Utils
// ----------------------------------------------------------------------------
const nowTs = () => admin.firestore.Timestamp.now();
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function minutesBetween(a: admin.firestore.Timestamp, b: admin.firestore.Timestamp) {
  return Math.max(0, (b.toMillis() - a.toMillis()) / 60000);
}

function toIsoMaybe(ts?: admin.firestore.Timestamp | null) {
  if (!ts) return null;
  try { return ts.toDate().toISOString(); } catch { return null; }
}

function getByPath(obj: any, path: string) {
  if (!path) return undefined;
  return path.split(".").reduce((acc: any, key: string) => (acc ? acc[key] : undefined), obj);
}

// ----------------------------------------------------------------------------
// OAuth & GraphQL Helpers
// ----------------------------------------------------------------------------
async function getNxAccessToken() {
  const tokenUrl = process.env.OAUTH_TOKEN_URL || "https://auth.nexiiot.io/oauth/token";
  const form = new URLSearchParams({
    grant_type: "password",
    username: process.env.SERVICE_USERNAME || "",
    password: process.env.SERVICE_PASSWORD || "",
    client_id: process.env.OAUTH_CLIENT_ID || "",
    client_secret: process.env.OAUTH_CLIENT_SECRET || "",
  });

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch {
    throw new Error(`token_non_json status=${r.status} body=${text.slice(0, 160)}`);
  }
  if (!r.ok || json.error) {
    throw new Error(`token_error status=${r.status} error=${json.error || "unknown"} desc=${json.error_description || ""}`);
  }
  return { access_token: json.access_token as string, expires_in: json.expires_in as number };
}

async function gqlRequest<T = any>(accessToken: string, body: { query: string; variables?: any }) {
  const url = process.env.NX_GRAPHQL_URL || "https://gqlv2.nexiiot.io/graphql";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(async () => ({ raw: await r.text() }));
  return { ok: r.ok, status: r.status, data } as { ok: boolean; status: number; data: T };
}

// ----------------------------------------------------------------------------
// Shadow Fetcher (REPLACE GraphQL query with your real schema)
// ----------------------------------------------------------------------------
// This function fetches the latest shadow values for a device and returns a flat map
// of { shadowKey: value }. It supports two common shapes: (A) an object map, or (B) an array of {name,value}.
// Update the GraphQL query and extraction logic to match your NexIIoT schema.

async function fetchNexiiotShadowValues(devCfg: DeviceConfig): Promise<Record<string, any>> {
  const deviceId = devCfg.nexiiotDeviceId?.trim();
  if (!deviceId) throw new Error("missing_nexiiotDeviceId_in_device_config");

  const { access_token } = await getNxAccessToken();

  // TODO [IMPORTANT]: Replace this query with your real NexIIoT schema.
  // Example 1 (object map):
  //   query ($id: String!) { shadow(deviceId: $id) { json } }
  //   where json is a JSON object of key/value pairs
  // Example 2 (array pairs):
  //   query ($id: String!) { shadow(deviceId: $id) { fields { name value ts } } }

  const query = /* GraphQL */ `
    query GetShadow($id: String!) {
      shadow(deviceId: $id) {
        json
        fields { name value ts }
      }
    }
  `;

  const { ok, status, data } = await gqlRequest<any>(access_token, { query, variables: { id: deviceId } });
  if (!ok) throw new Error(`graphql_status_${status}`);

  const shadow: any = (data as any)?.data?.shadow;
  if (!shadow) throw new Error("shadow_null");

  // Try to adapt to either shape
  const values: Record<string, any> = {};
  if (shadow.json && typeof shadow.json === "object") {
    Object.assign(values, shadow.json);
  }
  if (Array.isArray(shadow.fields)) {
    for (const f of shadow.fields) {
      if (f && typeof f.name === "string") values[f.name] = f.value;
    }
  }

  if (Object.keys(values).length === 0) throw new Error("shadow_values_empty");
  return values;
}

// ----------------------------------------------------------------------------
// Compute Logic: goodNow / percent / level
// ----------------------------------------------------------------------------
function computeGoodNow(values: Record<string, any>, devCfg: DeviceConfig): boolean {
  const thresholds = devCfg.thresholds || {};
  const vmap = devCfg.variableMap || {};

  for (const logicalKey of Object.keys(thresholds)) {
    const t = thresholds[logicalKey] || {};
    const shadowKey = vmap[logicalKey] || logicalKey; // fallback: use same key

    // read value by exact key or dot-path
    let val: any = values[shadowKey];
    if (val === undefined && shadowKey.includes(".")) val = getByPath(values, shadowKey);

    const num = typeof val === "number" ? val : Number(val);
    if (Number.isNaN(num)) return false;

    if (typeof t.min === "number" && num < t.min) return false;
    if (typeof t.max === "number" && num > t.max) return false;
  }
  return true; // all defined thresholds passed
}

function levelFromPercent(p: number): string {
  if (p >= 100) return "READY";
  if (p >= 67) return "HIGH";
  if (p >= 34) return "MID";
  return "LOW";
}

async function computeAndMaybePersist(deviceId: string, opts: { dryRun?: boolean } = {}) {
  const dryRun = !!opts.dryRun;

  // Config & previous progress
  const devSnap = await DEVICES_COL.doc(deviceId).get();
  if (!devSnap.exists) throw new Error(`device_config_not_found:${deviceId}`);
  const devCfg = (devSnap.data() || {}) as DeviceConfig;

  const prevSnap = await PROGRESS_COL.doc(deviceId).get();
  const prev = (prevSnap.exists ? (prevSnap.data() as ProgressDoc) : undefined);

  // Fetch values from NexIIoT
  let values: Record<string, any> = {};
  try {
    values = await fetchNexiiotShadowValues(devCfg);
  } catch (e: any) {
    logger.error(JSON.stringify({ tag: "compute", stage: "fetch_shadow", deviceId, error: String(e?.message || e) }));
    throw e;
  }

  // Compute goodNow
  const goodNow = computeGoodNow(values, devCfg);

  // Compute percent by continuous-good window
  const windowMinutes = Math.max(1, Math.floor(devCfg.windowMinutes || 60));
  const now = nowTs();

  let goodSince: admin.firestore.Timestamp | null = prev?.goodSince || null;
  if (goodNow) {
    if (!prev?.goodNow || !prev?.goodSince) goodSince = now; // newly turned good
  } else {
    // reset if not good (require continuous good window)
    goodSince = null;
  }

  let percent = prev?.percent || 0;
  if (goodNow && goodSince) {
    const mins = minutesBetween(goodSince, now);
    percent = clamp(Math.floor((mins / windowMinutes) * 100), 0, 100);
  }

  const level = levelFromPercent(percent);

  const progress: Omit<ProgressDoc, "updatedAt" | "goodSince"> & { updatedAt: admin.firestore.Timestamp; goodSince: admin.firestore.Timestamp | null } = {
    percent,
    level,
    goodNow,
    goodSince: goodSince || null,
    lastValues: values,
    updatedAt: now,
  };

  if (!dryRun) {
    await PROGRESS_COL.doc(deviceId).set(progress, { merge: true });
  }

  return {
    deviceId,
    percent,
    level,
    goodNow,
    goodSinceIso: toIsoMaybe(progress.goodSince),
    updatedAtIso: toIsoMaybe(progress.updatedAt),
    persisted: !dryRun,
  };
}

// ----------------------------------------------------------------------------
// HTTP: diagSecrets — presence only (no values)
// ----------------------------------------------------------------------------
export const diagSecrets = onRequest(
  { cors: true, secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SERVICE_USERNAME, SERVICE_PASSWORD, OAUTH_TOKEN_URL, NX_GRAPHQL_URL] },
  async (_req: Request, res: Response) => {
    const has = (k: string) => Boolean((process.env as any)[k]);
    res.json({
      OAUTH_CLIENT_ID: has("OAUTH_CLIENT_ID"),
      OAUTH_CLIENT_SECRET: has("OAUTH_CLIENT_SECRET"),
      SERVICE_USERNAME: has("SERVICE_USERNAME"),
      SERVICE_PASSWORD: has("SERVICE_PASSWORD"),
      OAUTH_TOKEN_URL: has("OAUTH_TOKEN_URL"),
      NX_GRAPHQL_URL: has("NX_GRAPHQL_URL"),
    });
  }
);

// ----------------------------------------------------------------------------
// HTTP: diagToken — exchange token & return masked metadata
// ----------------------------------------------------------------------------
export const diagToken = onRequest(
  { cors: true, secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SERVICE_USERNAME, SERVICE_PASSWORD, OAUTH_TOKEN_URL] },
  async (_req: Request, res: Response) => {
    try {
      const t = await getNxAccessToken();
      const preview = (t.access_token || "").slice(0, 8) + "...";
      res.json({ ok: true, preview, expires_in: t.expires_in });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

// ----------------------------------------------------------------------------
// HTTP: diagGraphql — run a tiny GraphQL query via server-side token
// ----------------------------------------------------------------------------
export const diagGraphql = onRequest(
  { cors: true, secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SERVICE_USERNAME, SERVICE_PASSWORD, OAUTH_TOKEN_URL, NX_GRAPHQL_URL] },
  async (req: Request, res: Response) => {
    try {
      const { access_token } = await getNxAccessToken();
      const query = (req.body && req.body.query) || "query { __typename }";
      const variables = (req.body && req.body.variables) || {};
      const r = await gqlRequest(access_token, { query, variables });
      res.status(r.status).json({ ok: r.ok, status: r.status, data: r.data });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

// ----------------------------------------------------------------------------
// HTTP: getProgress — read latest progress for deviceId
// ----------------------------------------------------------------------------
export const getProgress = onRequest(
  { cors: true },
  async (req: Request, res: Response) => {
    const deviceId = String(req.query.deviceId || "");
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

    const doc = await PROGRESS_COL.doc(deviceId).get();
    if (!doc.exists) return res.status(404).json({ error: "not_found" });

    const d = doc.data() as ProgressDoc;
    res.json({
      deviceId,
      percent: d.percent,
      level: d.level,
      goodNow: d.goodNow,
      goodSince: toIsoMaybe(d.goodSince || null),
      updatedAt: toIsoMaybe(d.updatedAt),
      lastValues: d.lastValues || {},
    });
  }
);

// ----------------------------------------------------------------------------
// HTTP: recomputeOne — manual trigger for one device (dryRun supported)
// ----------------------------------------------------------------------------
export const recomputeOne = onRequest(
  { cors: true, secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SERVICE_USERNAME, SERVICE_PASSWORD, OAUTH_TOKEN_URL, NX_GRAPHQL_URL] },
  async (req: Request, res: Response) => {
    const deviceId = String(req.query.deviceId || "");
    const dryRun = String(req.query.dryRun || "false").toLowerCase() === "true";
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

    try {
      const out = await computeAndMaybePersist(deviceId, { dryRun });
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  }
);

// ----------------------------------------------------------------------------
// HTTP: diagPollStatus — read the latest scheduler snapshot
// ----------------------------------------------------------------------------
export const diagPollStatus = onRequest(
  { cors: true },
  async (_req: Request, res: Response) => {
    const snap = await STATE_REF.get();
    if (!snap.exists) return res.json({ exists: false });

    const data: any = snap.data();
    const lastRunAtIso = data?.lastRunAt?.toDate ? data.lastRunAt.toDate().toISOString() : data?.lastRunAt || null;
    const startedAtIso = data?.startedAt?.toDate ? data.startedAt.toDate().toISOString() : data?.startedAt || null;

    res.json({
      exists: true,
      status: data?.status || "unknown",
      runId: data?.runId || null,
      startedAtIso,
      lastRunAtIso,
      okCount: data?.okCount ?? 0,
      errCount: data?.errCount ?? 0,
      perDevice: data?.perDevice || {},
    });
  }
);

// ----------------------------------------------------------------------------
// SCHEDULE: pollNexiiot — every 5 minutes
// ----------------------------------------------------------------------------
export const pollNexiiot = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Asia/Bangkok",
    secrets: [
      OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SERVICE_USERNAME, SERVICE_PASSWORD,
      OAUTH_TOKEN_URL, NX_GRAPHQL_URL,
    ],
  },
  async () => {
    const runId = Date.now();
    const startedAt = nowTs();

    await STATE_REF.set({ status: "running", runId, startedAt }, { merge: true });

    let okCount = 0, errCount = 0;
    const perDevice: Record<string, any> = {};

    const devs = await DEVICES_COL.get();
    for (const snap of devs.docs) {
      const deviceId = snap.id;
      try {
        const out = await computeAndMaybePersist(deviceId, { dryRun: false });
        okCount++;
        perDevice[deviceId] = { percent: out.percent, level: out.level, updatedAt: out.updatedAtIso };
        logger.info(JSON.stringify({ tag: "pollNexiiot", deviceId, ok: true, ...perDevice[deviceId] }));
      } catch (e: any) {
        errCount++;
        const errMsg = String(e?.message || e);
        perDevice[deviceId] = { error: errMsg };
        logger.error(JSON.stringify({ tag: "pollNexiiot", deviceId, ok: false, error: errMsg }));
      }
    }

    const finishedAt = nowTs();
    await STATE_REF.set(
      { status: "idle", runId, lastRunAt: finishedAt, okCount, errCount, perDevice },
      { merge: true }
    );
  }
);

