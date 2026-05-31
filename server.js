// server.js @AridaniDahlGuerra (backend lead – shared infrastructure, WebSocket, Firestore, auth, drone simulation, fleet)
require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");

// Firebase Firestore
const { db, ordersCol, dronesCol, contactsCol, usersCol } = require("./firebase");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ===== Configuration =====
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
if (ADMIN_KEY === "change-me") {
  console.warn(
    "[WARN] ADMIN_KEY is not set. Using default 'change-me'. Set ADMIN_KEY in an environment variable for better security."
  );
}

// Simple auth tokens (in-memory).
const authTokens = new Map(); // token -> { userId, role, createdAt }
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

function id(nBytes = 16) {
  return crypto.randomBytes(nBytes).toString("hex");
}
function nanoidLike(len = 10) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}
function issueToken(userId, role) {
  const token = id(16);
  authTokens.set(token, { userId, role, createdAt: Date.now() });
  return token;
}
function pruneTokens() {
  const now = Date.now();
  for (const [t, meta] of authTokens.entries()) {
    if (now - meta.createdAt > TOKEN_TTL_MS) authTokens.delete(t);
  }
}

function requireAuth(req, res, next) {
  pruneTokens();
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer (.+)$/i);
  const token = m ? m[1] : null;
  if (!token) return res.status(401).json({ error: "Authorization required." });
  const session = authTokens.get(token);
  if (!session) return res.status(401).json({ error: "Invalid/expired token." });
  req.user = { id: session.userId, role: session.role };
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin authorization required." });
    next();
  });
}
function requireCustomer(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "customer") {
      return res.status(403).json({ error: "Customer authorization required." });
    }
    next();
  });
}

// ===== Firestore helper functions ===== @AridaniDahlGuerra
// These provide a NeDB-like interface over Firestore for easier migration

async function fsInsert(col, doc) {
  const ref = await col.add(doc);
  return { ...doc, _id: ref.id };
}

async function fsFindOne(col, filters) {
  if (filters._id) {
    const snap = await col.doc(filters._id).get();
    if (!snap.exists) return null;
    return { _id: snap.id, ...snap.data() };
  }
  let q = col;
  for (const [k, v] of Object.entries(filters)) {
    q = q.where(k, "==", v);
  }
  const snap = await q.limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { _id: d.id, ...d.data() };
}

async function fsFind(col, filters = {}, sortField = null, sortDir = "asc") {
  let q = col;
  for (const [k, v] of Object.entries(filters)) {
    if (k === "$or" || k === "$in") continue; // handled separately
    if (typeof v === "object" && v !== null && v.$in) {
      // Firestore 'in' query (max 30 values)
      q = q.where(k, "in", v.$in);
    } else {
      q = q.where(k, "==", v);
    }
  }
  if (sortField) q = q.orderBy(sortField, sortDir);
  const snap = await q.get();
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

async function fsUpdate(col, docId, patch) {
  await col.doc(docId).update(patch);
}

async function fsCount(col, filters = {}) {
  let q = col;
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === "object" && v !== null && v.$in) {
      q = q.where(k, "in", v.$in);
    } else {
      q = q.where(k, "==", v);
    }
  }
  const snap = await q.count().get();
  return snap.data().count;
}

async function fsRemove(col, docId) {
  await col.doc(docId).delete();
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===== Users / Auth ===== @AridaniDahlGuerra @AssaadMohammadAatfaYamlik
function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt) {
  const buf = crypto.scryptSync(password, salt, 64);
  return buf.toString("hex");
}

async function ensureBootstrapAdmin() {
  const existing = await fsFindOne(usersCol, { role: "admin" });
  if (existing) return;

  const salt = id(16);
  const passwordHash = hashPassword(ADMIN_KEY, salt);
  await fsInsert(usersCol, {
    username: "admin",
    role: "admin",
    salt,
    passwordHash,
    createdAt: nowIso(),
  });
  console.log("[INFO] Bootstrap admin created: username=admin (password from ADMIN_KEY env)");
}

// ===== Drone Realism Constants ===== @AridaniDahlGuerra
const CRUISE_ALT_M        = 120;   // cruising altitude in meters
const VERTICAL_SPEED_MPS  = 3;     // climb / descent rate m/s
const SENSOR_BUBBLE_M     = 50;    // proximity sensor radius
const OBSTACLE_CHANCE     = 0.05;  // 5% per tick while cruising
const SIGNAL_LOSS_CHANCE  = 0.02;  // 2% per tick
const SIGNAL_LOSS_TICKS   = 3;     // ticks of signal loss
const BASKET_OPEN_TICKS   = 4;     // ticks for basket operations
const EMERGENCY_BATT_PCT  = 15;    // auto-return threshold
const CRITICAL_BATT_PCT   = 5;     // emergency landing threshold

// ===== Basket / Cargo Dimensions per drone type (cm) ===== @AridaniDahlGuerra
const BASKET_DIMENSIONS = {
  light:     { lengthCm: 30, widthCm: 25, heightCm: 20, label: "Light (30×25×20 cm)" },
  heavy:     { lengthCm: 45, widthCm: 35, heightCm: 30, label: "Heavy (45×35×30 cm)" },
  longrange: { lengthCm: 40, widthCm: 30, heightCm: 25, label: "Long-range (40×30×25 cm)" },
};

function packageFitsBasket(pkgL, pkgW, pkgH, basketType) {
  const b = BASKET_DIMENSIONS[basketType];
  if (!b) return false;
  const dims = [
    [pkgL, pkgW, pkgH], [pkgL, pkgH, pkgW],
    [pkgW, pkgL, pkgH], [pkgW, pkgH, pkgL],
    [pkgH, pkgL, pkgW], [pkgH, pkgW, pkgL],
  ];
  return dims.some(([l, w, h]) => l <= b.lengthCm && w <= b.widthCm && h <= b.heightCm);
}

function findFittingBasketTypes(pkgL, pkgW, pkgH) {
  return Object.keys(BASKET_DIMENSIONS).filter(type => packageFitsBasket(pkgL, pkgW, pkgH, type));
}

// ===== Free Weather API (Open-Meteo) ===== @AridaniDahlGuerra
async function fetchWeatherForCoords(lat, lng) {
  if (typeof fetch !== "function") return generateFallbackWeather();
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return generateFallbackWeather();
    const d = await res.json();
    const cw = d.current_weather;
    if (!cw) return generateFallbackWeather();
    
    let condition = "clear";
    let icon = "01d";
    const code = cw.weathercode || 0;
    
    if (code >= 1 && code <= 3) { condition = "clouds"; icon = "03d"; }
    else if (code === 45 || code === 48) { condition = "mist"; icon = "50d"; }
    else if (code >= 51 && code <= 55) { condition = "drizzle"; icon = "09d"; }
    else if (code >= 61 && code <= 65) { condition = "rain"; icon = "10d"; }
    else if (code >= 71 && code <= 77) { condition = "snow"; icon = "13d"; }
    else if (code >= 95) { condition = "thunderstorm"; icon = "11d"; }
    
    return {
      source: "open-meteo",
      temperature: cw.temperature ?? 10,
      windSpeedKmh: cw.windspeed ?? 0,
      windDirection: cw.winddirection ?? 0,
      humidity: 50, // Open-Meteo current_weather doesn't return humidity by default, default to 50
      condition: condition,
      description: "real-time data",
      icon: icon,
      fetchedAt: nowIso(),
    };
  } catch (e) {
    console.error("[WeatherAPI] Failed to fetch:", e);
    return generateFallbackWeather();
  }
}

function generateFallbackWeather() {
  const hour = new Date().getHours();
  const temp = 5 + Math.sin((hour - 6) * Math.PI / 12) * 10 + (Math.random() * 4 - 2);
  const conditions = ["clear", "clouds", "rain", "snow"];
  return {
    source: "simulated",
    temperature: Math.round(temp * 10) / 10,
    windSpeedKmh: Math.round(Math.random() * 30),
    windDirection: Math.round(Math.random() * 360),
    humidity: Math.round(40 + Math.random() * 40),
    condition: conditions[Math.floor(Math.random() * conditions.length)],
    description: "simulated (no API key)",
    icon: "01d",
    fetchedAt: nowIso(),
  };
}

function weatherSpeedFactor(weather, bearingDeg) {
  if (!weather) return 1;
  const windKmh = weather.windSpeedKmh || 0;
  const windDir = weather.windDirection || 0;
  const diff = Math.abs(bearingDeg - windDir);
  const angleFactor = Math.cos((diff * Math.PI) / 180);
  return Math.max(0.6, Math.min(1.4, 1 - (angleFactor * windKmh) / 200));
}

function weatherBatteryFactor(weather) {
  if (!weather) return 1;
  const temp = weather.temperature ?? 10;
  if (temp < 0) return 1.3;
  if (temp < 5) return 1.15;
  if (temp < 10) return 1.05;
  return 1;
}

// ===== Geofencing / No-Fly Zones ===== @AridaniDahlGuerra
const NO_FLY_ZONES = [
  {
    id: "nfz-basto-fosen",
    name: "Bastø Fosen Ferjekai",
    type: "circle",
    center: { lat: 59.4175, lng: 10.4855 },
    radiusKm: 0.8, // Set a reasonable restricted area around the ferry terminal
    severity: "restricted",
  },
];

function pointInNoFlyZone(lat, lng) {
  for (const z of NO_FLY_ZONES) {
    if (z.type === "circle") {
      const dist = haversineKm(lat, lng, z.center.lat, z.center.lng);
      if (dist <= z.radiusKm) return z;
    }
  }
  return null;
}

function pointNearNoFlyZone(lat, lng, bufferKm = 0.5) {
  for (const z of NO_FLY_ZONES) {
    if (z.type === "circle") {
      const dist = haversineKm(lat, lng, z.center.lat, z.center.lng);
      if (dist <= z.radiusKm + bufferKm) return { zone: z, distKm: dist };
    }
  }
  return null;
}

// Helper: find drone doc by droneId field and update it
async function updateDroneByDroneId(droneIdVal, patch) {
  const drone = await fsFindOne(dronesCol, { droneId: droneIdVal });
  if (!drone) return;
  await fsUpdate(dronesCol, drone._id, patch);
}

async function ensureSeedDrones() {
  const count = await fsCount(dronesCol, {});
  if (count > 0) return;

  const seed = [
    { droneId: "LT-01", droneType: "light", battery: 100, remoteId: { serial: "NO-LT-2024-001", operator: "SkyNet", registration: "NO" } },
    { droneId: "LT-02", droneType: "light", battery: 88,  remoteId: { serial: "NO-LT-2024-002", operator: "SkyNet", registration: "NO" } },
    { droneId: "LT-03", droneType: "light", battery: 72,  remoteId: { serial: "NO-LT-2024-003", operator: "SkyNet", registration: "NO" } },
    { droneId: "HV-01", droneType: "heavy", battery: 100, remoteId: { serial: "NO-HV-2024-001", operator: "SkyNet", registration: "NO" } },
    { droneId: "HV-02", droneType: "heavy", battery: 95,  remoteId: { serial: "NO-HV-2024-002", operator: "SkyNet", registration: "NO" } },
    { droneId: "HV-03", droneType: "heavy", battery: 65,  remoteId: { serial: "NO-HV-2024-003", operator: "SkyNet", registration: "NO" } },
    { droneId: "LR-01", droneType: "longrange", battery: 100, remoteId: { serial: "NO-LR-2024-001", operator: "SkyNet", registration: "NO" } },
    { droneId: "LR-02", droneType: "longrange", battery: 80,  remoteId: { serial: "NO-LR-2024-002", operator: "SkyNet", registration: "NO" } },
    { droneId: "LR-03", droneType: "longrange", battery: 55,  remoteId: { serial: "NO-LR-2024-003", operator: "SkyNet", registration: "NO" } },
  ];
  for (const d of seed) {
    await fsInsert(dronesCol, {
      droneId: d.droneId,
      droneType: d.droneType,
      battery: d.battery,
      status: d.battery < 100 ? "charging" : "idle",
      assignedOrderId: null,
      remoteId: d.remoteId,
      updatedAt: nowIso(),
      createdAt: nowIso(),
    });
  }
  console.log("[INFO] Seeded drone fleet:", seed.map((s) => `${s.droneId} (${s.droneType})`).join(", "));
}

function requiredBatteryPctForTrip(kmTotal, deliveryType) {
  const drainPerKm = batteryDrainPerKm(deliveryType);
  const baseNeed = kmTotal * drainPerKm;
  const overhead = 1.1;
  const reserve = 10;
  return baseNeed * overhead + reserve;
}

function approxRangeKmFromBattery(batteryPct, deliveryType) {
  const drainPerKm = batteryDrainPerKm(deliveryType);
  if (drainPerKm <= 0) return 0;
  return Math.max(0, (batteryPct - 10) / drainPerKm);
}

async function pickAvailableDroneForOrder(kmTotal, deliveryType) {
  // Firestore: query idle and charging drones separately then merge
  const idleDrones = await fsFind(dronesCol, { status: "idle" });
  const chargingDrones = await fsFind(dronesCol, { status: "charging" });
  const drones = [...idleDrones, ...chargingDrones].sort((a, b) => (b.battery ?? 0) - (a.battery ?? 0));
  const need = requiredBatteryPctForTrip(kmTotal, deliveryType);

  const matched = drones.find((d) => d.droneType === deliveryType && (d.battery ?? 0) >= need);
  const chosen = matched || drones.find((d) => (d.battery ?? 0) >= need);

  if (chosen && chosen.status === "charging") stopCharging(chosen.droneId);
  return chosen || null;
}

async function assignDroneToOrder(orderId, droneId) {
  await updateDroneByDroneId(droneId, { status: "assigned", assignedOrderId: orderId, updatedAt: nowIso() });
}

// ===== Drone charging system ===== @AridaniDahlGuerra
const chargingTimers = new Map();

function stopCharging(droneId) {
  const h = chargingTimers.get(droneId);
  if (h) clearInterval(h);
  chargingTimers.delete(droneId);
}

function startCharging(droneId) {
  stopCharging(droneId);
  const CHARGE_INTERVAL_MS = 3000;
  const CHARGE_STEP = 2;

  const handle = setInterval(async () => {
    try {
      const d = await fsFindOne(dronesCol, { droneId });
      if (!d || d.status !== "charging") { stopCharging(droneId); return; }
      const newBatt = Math.min(100, (d.battery ?? 0) + CHARGE_STEP);
      const patch = { battery: newBatt, updatedAt: nowIso() };
      if (newBatt >= 100) patch.status = "idle";
      await fsUpdate(dronesCol, d._id, patch);
      if (newBatt >= 100) stopCharging(droneId);
    } catch (e) {
      console.error("[CHARGING]", droneId, e);
      stopCharging(droneId);
    }
  }, CHARGE_INTERVAL_MS);

  chargingTimers.set(droneId, handle);
}

async function releaseDrone(droneId, { battery } = {}) {
  const batt = typeof battery === "number" ? Math.max(0, Math.min(100, battery)) : null;
  const patch = { status: batt != null && batt < 100 ? "charging" : "idle", assignedOrderId: null, updatedAt: nowIso() };
  if (batt != null) patch.battery = batt;
  await updateDroneByDroneId(droneId, patch);
  if (patch.status === "charging") startCharging(droneId);
}

// ===== Helpers (ported from your Python drone simulation code) =====
function toRad(d) {
  return (d * Math.PI) / 180;
}
function toDeg(r) {
  return (r * 180) / Math.PI;
}
function wrapDeg(d) {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);

  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dlon = toRad(lon2 - lon1);
  const y = Math.sin(dlon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlon);
  const brng = toDeg(Math.atan2(y, x));
  return wrapDeg(brng);
}

function moveKm(lat, lon, brngDeg, distanceKm) {
  const R = 6371.0;
  const phi1 = toRad(lat);
  const lam1 = toRad(lon);
  const theta = toRad(brngDeg);
  const delta = distanceKm / R;

  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );

  const lat2 = toDeg(phi2);
  const lon2 = (toDeg(lam2) + 540.0) % 360.0 - 180.0;
  return { lat: lat2, lng: lon2 };
}

function mkEvent(type, message) {
  return { id: nanoidLike(10), type, message, time: nowIso() };
}

function speedKmph(type) {
  if (type === "light") return 50;
  if (type === "heavy") return 35;
  if (type === "longrange") return 45;
  if (type === "express") return 60;
  if (type === "standard") return 40;
  if (type === "fragile") return 30;
  return 40;
}

function batteryDrainPerKm(type) {
  if (type === "light") return 1.6;
  if (type === "heavy") return 1.8;
  if (type === "longrange") return 1.0;
  if (type === "express") return 2.2;
  if (type === "standard") return 1.6;
  if (type === "fragile") return 1.8;
  return 1.5;
}

// ===== Minimal WebSocket server (no deps) ===== @AridaniDahlGuerra
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsClients = new Set(); // { socket, user, subs: { orderId, all, contacts }, buf }

function wsAcceptKey(secKey) {
  return crypto.createHash("sha1").update(secKey + WS_GUID).digest("base64");
}

function wsSend(socket, obj) {
  try {
    const data = Buffer.from(JSON.stringify(obj), "utf8");
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.from([0x81, 126, (len >> 8) & 255, len & 255]);
    } else {
      header = Buffer.from([0x81, 127, 0, 0, 0, 0, (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
    }
    socket.write(Buffer.concat([header, data]));
  } catch {
    // ignore
  }
}

function wsClose(socket) {
  try {
    socket.end();
  } catch {}
}

function wsBroadcastOrder(order) {
  for (const c of wsClients) {
    if (c.subs?.all) continue;
    if (c.subs?.orderId && c.subs.orderId === order._id) {
      wsSend(c.socket, { type: "order_update", order });
    }
  }
  scheduleFleetBroadcast();
}

let fleetBroadcastTimer = null;
function scheduleFleetBroadcast() {
  if (fleetBroadcastTimer) return;
  fleetBroadcastTimer = setTimeout(async () => {
    fleetBroadcastTimer = null;
    const anyFleetSubs = [...wsClients].some((c) => c.subs?.all || c.subs?.orderId);
    if (!anyFleetSubs) return;

    const active = await fsFind(ordersCol, { status: { $in: ["accepted", "in_transit", "returning"] } });
    const drones = active
      .map((o) => ({
        orderId: o._id,
        status: o.status,
        droneId: o.drone?.droneId || null,
        position: o.dronePosition || null,
      }))
      .filter((d) => d.position && typeof d.position.lat === "number" && typeof d.position.lng === "number");

    // Public fleet strips out orderId and sensitive info
    const publicDrones = drones.map(d => ({
      droneId: d.droneId,
      position: d.position
    }));

    for (const c of wsClients) {
      if (c.subs?.all) {
        wsSend(c.socket, { type: "fleet", drones });
      } else if (c.subs?.orderId) {
        if (c.user?.role === "admin") {
          wsSend(c.socket, { type: "public_fleet", drones: publicDrones });
        }
      }
    }
  }, 700);
}

function parseWsFrames(buffer) {
  let offset = 0;
  const messages = [];

  while (offset + 2 <= buffer.length) {
    const b1 = buffer[offset];
    const b2 = buffer[offset + 1];
    const fin = (b1 & 0x80) !== 0;
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f;
    let headerLen = 2;

    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      const hi = buffer.readUInt32BE(offset + 2);
      const lo = buffer.readUInt32BE(offset + 6);
      len = hi * 2 ** 32 + lo;
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const frameLen = headerLen + maskLen + len;
    if (offset + frameLen > buffer.length) break;

    if (!fin) {
      offset += frameLen;
      continue;
    }

    if (opcode === 0x8) return { messages, remaining: Buffer.alloc(0), closed: true };
    if (opcode === 0x9) {
      offset += frameLen;
      continue;
    }
    if (opcode !== 0x1) {
      offset += frameLen;
      continue;
    }

    let payload = buffer.slice(offset + headerLen + maskLen, offset + frameLen);
    if (masked) {
      const mask = buffer.slice(offset + headerLen, offset + headerLen + 4);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    messages.push(payload.toString("utf8"));
    offset += frameLen;
  }

  return { messages, remaining: buffer.slice(offset), closed: false };
}

// ---- Contacts unread badge helpers (uses adminUnread/customerUnread) ----
async function unreadCountForUser(user) {
  if (!user) return 0;
  if (user.role === "admin") return await fsCount(contactsCol, { adminUnread: true });
  return await fsCount(contactsCol, { customerId: user.id, customerUnread: true });
}

async function wsBroadcastContactsUnread({ customerIdAffected = null } = {}) {
  let adminCount = null;
  const customerCountCache = new Map();

  for (const c of wsClients) {
    if (!c.subs?.contacts) continue;

    if (c.user.role === "admin") {
      if (adminCount == null) adminCount = await fsCount(contactsCol, { adminUnread: true });
      wsSend(c.socket, { type: "contacts_unread", count: adminCount });
      continue;
    }

    if (customerIdAffected && c.user.id !== customerIdAffected) continue;

    if (!customerCountCache.has(c.user.id)) {
      const n = await fsCount(contactsCol, { customerId: c.user.id, customerUnread: true });
      customerCountCache.set(c.user.id, n);
    }
    wsSend(c.socket, { type: "contacts_unread", count: customerCountCache.get(c.user.id) });
  }
}

server.on("upgrade", (req, socket) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();

    pruneTokens();
    const token = url.searchParams.get("token") || "";
    const session = authTokens.get(token);
    if (!session) return socket.destroy();

    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();

    const acceptKey = wsAcceptKey(String(key));
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ];
    socket.write(headers.join("\r\n"));

    const client = {
      socket,
      user: { id: session.userId, role: session.role },
      subs: { orderId: null, all: false, contacts: false },
      buf: Buffer.alloc(0),
    };
    wsClients.add(client);

    socket.on("data", async (chunk) => {
      client.buf = Buffer.concat([client.buf, chunk]);
      const parsed = parseWsFrames(client.buf);
      client.buf = parsed.remaining;
      if (parsed.closed) {
        wsClients.delete(client);
        return wsClose(socket);
      }

      for (const msg of parsed.messages) {
        let data;
        try {
          data = JSON.parse(msg);
        } catch {
          continue;
        }

        if (data.type === "subscribe") {
          const orderId = String(data.orderId || "").trim();
          if (!orderId) continue;

          const order = await fsFindOne(ordersCol, { _id: orderId });
          if (!order) {
            wsSend(socket, { type: "error", message: "Order not found." });
            continue;
          }
          if (client.user.role !== "admin" && order.customerId !== client.user.id) {
            wsSend(socket, { type: "error", message: "Not allowed." });
            continue;
          }

          client.subs.orderId = orderId;
          client.subs.all = false;
          wsSend(socket, { type: "order_update", order });
        }

        if (data.type === "subscribe_all") {
          if (client.user.role !== "admin") {
            wsSend(socket, { type: "error", message: "Admin only." });
            continue;
          }
          client.subs.orderId = null;
          client.subs.all = true;
          scheduleFleetBroadcast();
        }

        // Contacts badge subscription
        if (data.type === "subscribe_contacts") {
          client.subs.contacts = true;
          try {
            const count = await unreadCountForUser(client.user);
            wsSend(socket, { type: "contacts_unread", count });
          } catch {}
        }
      }
    });

    socket.on("close", () => wsClients.delete(client));
    socket.on("end", () => wsClients.delete(client));
    socket.on("error", () => wsClients.delete(client));
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
});

// ===== Simulation manager (server-side) ===== @AridaniDahlGuerra
const sim = new Map(); // orderId -> intervalHandle

async function stopSimulation(orderId) {
  const h = sim.get(orderId);
  if (h) clearInterval(h);
  sim.delete(orderId);
}

async function appendEvent(orderId, ev) {
  const order = await fsFindOne(ordersCol, { _id: orderId });
  if (!order) return;
  const events = Array.isArray(order.events) ? order.events : [];
  events.push(ev);
  await fsUpdate(ordersCol, orderId, { events, updatedAt: nowIso() });
}

async function updateOrder(orderId, patch) {
  await fsUpdate(ordersCol, orderId, { ...patch, updatedAt: nowIso() });
  const doc = await fsFindOne(ordersCol, { _id: orderId });
  if (doc) wsBroadcastOrder(doc);
  return doc;
}

function orderBase(o) {
  const b = o.base;
  if (b && typeof b.lat === "number" && typeof b.lng === "number") return { lat: b.lat, lng: b.lng };
  return { lat: o.pickup.lat, lng: o.pickup.lng };
}

function totalRouteKm(base, pickup, delivery) {
  return (
    haversineKm(base.lat, base.lng, pickup.lat, pickup.lng) +
    haversineKm(pickup.lat, pickup.lng, delivery.lat, delivery.lng) +
    haversineKm(delivery.lat, delivery.lng, base.lat, base.lng)
  );
}

async function startSimulation(orderId) {
  const order = await fsFindOne(ordersCol, { _id: orderId });
  if (!order) throw new Error("Order not found");
  if (order.status === "delivered" || order.status === "cancelled") throw new Error("Cannot simulate delivered/cancelled order");

  const base = orderBase(order);
  const battery0 = typeof order.drone?.battery === "number" ? order.drone.battery : 100;

  let phase = order.missionPhase || "idle";
  const resumingFromLoad = phase === "awaiting_load";
  if (phase === "idle" || phase === "paused") phase = "ascending_base";
  if (phase === "awaiting_load") phase = "ascending_pickup";
  if (phase === "complete") throw new Error("Mission already completed");

  const nextStatus = resumingFromLoad ? "in_transit" : order.status || "in_transit";

  // When resuming from awaiting_load, fix position exactly at pickup to avoid ping-pong
  const startPos = resumingFromLoad
    ? { lat: order.pickup.lat, lng: order.pickup.lng, alt: 0 }
    : (order.dronePosition && typeof order.dronePosition.lat === "number" ? { ...order.dronePosition, alt: order.dronePosition.alt || 0 } : { lat: base.lat, lng: base.lng, alt: 0 });

  // Fetch weather for mission
  let weather = order.weather || null;
  if (!weather) {
    try {
      weather = await fetchWeatherForCoords(startPos.lat, startPos.lng);
    } catch { weather = generateFallbackWeather(); }
  }

  // Lookup remote ID from Firestore
  let remoteId = order.drone?.remoteId || null;
  if (!remoteId && order.drone?.droneId) {
    try {
      const droneDoc = await fsFindOne(dronesCol, { droneId: order.drone.droneId });
      remoteId = droneDoc?.remoteId || null;
    } catch {}
  }

  const baseline = {
    status: nextStatus,
    missionPhase: phase,
    dronePosition: startPos,
    weather,
    drone: {
      droneId: order.drone?.droneId || `DR-${nanoidLike(6).toUpperCase()}`,
      battery: battery0,
      speedKmph: speedKmph(order.deliveryType),
      remoteId,
    },
    telemetry: {
      altitude: startPos.alt || 0,
      heading: 0,
      verticalSpeed: 0,
      groundSpeed: 0,
      sensorBubble: { active: true, radiusM: SENSOR_BUBBLE_M, obstacleDetected: false },
      signalStrength: 100,
      gpsAccuracy: 1.2,
      basketState: "closed",
    },
  };

  await updateOrder(orderId, baseline);
  if (resumingFromLoad) {
    await appendEvent(orderId, mkEvent("mission", "📦 Package loaded into basket. Basket closing..."));
    await appendEvent(orderId, mkEvent("mission", "🔒 Basket secured. Ascending from pickup."));
  } else {
    await appendEvent(orderId, mkEvent("mission", "🚁 Mission started. Drone ascending from base."));
    if (weather) await appendEvent(orderId, mkEvent("weather", `🌤️ Weather: ${weather.description}, ${weather.temperature}°C, wind ${weather.windSpeedKmh} km/h (${weather.source})`));
  }

  await stopSimulation(orderId);

  // Simulation state (not persisted, only lives during tick loop)
  let signalLostTicks = 0;
  let basketTicks = 0;
  let obstacleAvoidanceActive = false;
  let avoidanceOffset = null;

  const tickMs = 1200;
  const handle = setInterval(async () => {
    try {
      const o = await fsFindOne(ordersCol, { _id: orderId });
      if (!o) return stopSimulation(orderId);
      if (o.status === "cancelled") {
        await appendEvent(orderId, mkEvent("mission", "❌ Mission stopped: order cancelled."));
        return stopSimulation(orderId);
      }
      if (o.status === "delivered") return stopSimulation(orderId);

      const baseNow = orderBase(o);
      const pickup = o.pickup;
      const delivery = o.delivery;
      const weatherNow = o.weather || weather;
      let phase = o.missionPhase || "ascending_base";
      const tel = o.telemetry || baseline.telemetry;
      let alt = tel.altitude || 0;
      let battery = o.drone?.battery ?? 100;
      const droneSpeed = speedKmph(o.deliveryType);
      const from = o.dronePosition || { lat: baseNow.lat, lng: baseNow.lng, alt: 0 };

      // ===== SIGNAL LOSS SIMULATION =====
      if (signalLostTicks > 0) {
        signalLostTicks--;
        if (signalLostTicks === 0) {
          await appendEvent(orderId, mkEvent("safety", "📡 Signal restored. Resuming flight."));
          await updateOrder(orderId, { telemetry: { ...tel, signalStrength: 95 + Math.round(Math.random() * 5) } });
        } else {
          await updateOrder(orderId, { telemetry: { ...tel, signalStrength: Math.round(Math.random() * 15) } });
        }
        return; // hold position during signal loss
      }
      // Random signal loss check during flight phases
      if ((phase === "to_pickup" || phase === "to_delivery" || phase === "returning") && Math.random() < SIGNAL_LOSS_CHANCE) {
        signalLostTicks = SIGNAL_LOSS_TICKS;
        await appendEvent(orderId, mkEvent("safety", "⚠️ Signal lost! Drone holding position..."));
        await updateOrder(orderId, { telemetry: { ...tel, signalStrength: 0 } });
        return;
      }

      // ===== CRITICAL BATTERY: EMERGENCY LANDING =====
      if (battery <= CRITICAL_BATT_PCT && phase !== "emergency_landing" && phase !== "complete") {
        await appendEvent(orderId, mkEvent("safety", "🔴 CRITICAL BATTERY! Emergency landing initiated."));
        phase = "emergency_landing";
        await updateOrder(orderId, { missionPhase: phase, status: "returning" });
      }

      // ===== EMERGENCY BATTERY: AUTO-RETURN =====
      if (battery <= EMERGENCY_BATT_PCT && battery > CRITICAL_BATT_PCT && phase !== "returning" && phase !== "descending_base" && phase !== "emergency_landing" && !o.emergencyReturnTriggered) {
        await appendEvent(orderId, mkEvent("safety", "🟡 Low battery (" + Math.round(battery) + "%). Emergency return to base."));
        phase = "returning";
        await updateOrder(orderId, { missionPhase: phase, status: "returning", emergencyReturnTriggered: true });
      }

      const altStepM = VERTICAL_SPEED_MPS * (tickMs / 1000); // meters per tick

      // ===== PHASE STATE MACHINE =====
      switch (phase) {
        // ------- ASCENDING FROM BASE -------
        case "ascending_base": {
          alt = Math.min(CRUISE_ALT_M, alt + altStepM);
          battery -= 0.15; // small battery drain for vertical flight
          if (alt >= CRUISE_ALT_M) {
            phase = "to_pickup";
            await appendEvent(orderId, mkEvent("mission", `✈️ Cruising altitude reached: ${CRUISE_ALT_M}m. Heading to pickup.`));
          }
          await updateOrder(orderId, {
            dronePosition: { ...from, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: VERTICAL_SPEED_MPS, groundSpeed: 0, heading: 0, basketState: "closed", sensorBubble: { ...tel.sensorBubble, active: true, obstacleDetected: false }, signalStrength: 95 + Math.round(Math.random() * 5) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        // ------- FLYING TO PICKUP -------
        case "to_pickup": {
          const target = pickup;
          const distKm = haversineKm(from.lat, from.lng, target.lat, target.lng);
          const brng = bearingDeg(from.lat, from.lng, target.lat, target.lng);
          const wFactor = weatherSpeedFactor(weatherNow, brng);
          const effectiveSpeed = droneSpeed * wFactor;
          const stepKm = Math.max(0.02, (effectiveSpeed / 3600) * (tickMs / 1000));

          // Proximity sensor: obstacle avoidance
          let sensorObstacle = false;
          if (!obstacleAvoidanceActive) {
            // Check for other active drones within 50m
            let nearbyDrone = false;
            try {
              // Only check for drone collisions if we are NOT very close to our target destination.
              // Otherwise, drones arriving at the same pickup/dropoff/base will infinitely avoid each other.
              const distToTarget = haversineKm(from.lat, from.lng, target.lat, target.lng);
              if (distToTarget > 0.15) { // Only check if > 150m from target
                const activeSimOrders = await fsFind(ordersCol, { status: { $in: ["in_transit", "returning", "accepted"] } });
                for (const aOrder of activeSimOrders) {
                  if (aOrder._id === orderId) continue;
                  if (aOrder.dronePosition) {
                    const d = haversineKm(from.lat, from.lng, aOrder.dronePosition.lat, aOrder.dronePosition.lng);
                    if (d <= 0.05) { // 50m
                      nearbyDrone = true;
                      break;
                    }
                  }
                }
              }
            } catch (e) {}

            if (nearbyDrone || Math.random() < OBSTACLE_CHANCE) {
              obstacleAvoidanceActive = true;
              sensorObstacle = true;
              // lateral offset perpendicular to bearing
              const offBrng = brng + (Math.random() > 0.5 ? 90 : -90);
              avoidanceOffset = moveKm(from.lat, from.lng, offBrng, 0.1); // 100m lateral
              const msg = nearbyDrone ? "🔴 Proximity sensor: nearby drone detected! Executing avoidance maneuver." : "🔴 Proximity sensor: obstacle detected! Executing avoidance maneuver.";
              await appendEvent(orderId, mkEvent("sensor", msg));
              await updateOrder(orderId, { obstacleCount: (o.obstacleCount || 0) + 1 });
            }
          }

          let next;
          if (obstacleAvoidanceActive && avoidanceOffset) {
            // Move to avoidance point, then resume
            const avDist = haversineKm(from.lat, from.lng, avoidanceOffset.lat, avoidanceOffset.lng);
            if (avDist < 0.05) {
              obstacleAvoidanceActive = false;
              avoidanceOffset = null;
              await appendEvent(orderId, mkEvent("sensor", "✅ Obstacle avoided. Resuming route."));
              next = moveKm(from.lat, from.lng, brng, Math.min(stepKm, distKm));
            } else {
              const avBrng = bearingDeg(from.lat, from.lng, avoidanceOffset.lat, avoidanceOffset.lng);
              next = moveKm(from.lat, from.lng, avBrng, Math.min(stepKm, avDist));
            }
          } else {
            next = moveKm(from.lat, from.lng, brng, Math.min(stepKm, distKm));
          }

          // No-fly zone check
          const nfzHit = pointNearNoFlyZone(next.lat, next.lng, 0.3);
          if (nfzHit) {
            // Deviate: add perpendicular offset
            const devBrng = brng + 90;
            next = moveKm(from.lat, from.lng, devBrng, stepKm);
            if (!o.nfzWarned) {
              await appendEvent(orderId, mkEvent("safety", `🚫 No-fly zone proximity: ${nfzHit.zone.name}. Deviating route.`));
              await updateOrder(orderId, { nfzWarned: true });
            }
          }

          const reached = haversineKm(next.lat, next.lng, target.lat, target.lng) <= 0.03;
          const drain = batteryDrainPerKm(o.deliveryType) * weatherBatteryFactor(weatherNow) * stepKm;
          battery = Math.max(0, battery - drain);

          if (reached) {
            phase = "descending_pickup";
            await appendEvent(orderId, mkEvent("mission", "📍 Arrived at pickup area. Descending to ground level."));
            next = { lat: target.lat, lng: target.lng };
          }

          const totalKm = totalRouteKm(baseNow, pickup, delivery);
          const remainingKm = haversineKm(next.lat, next.lng, pickup.lat, pickup.lng) + haversineKm(pickup.lat, pickup.lng, delivery.lat, delivery.lng) + haversineKm(delivery.lat, delivery.lng, baseNow.lat, baseNow.lng);
          const prog = totalKm > 0 ? Math.min(0.999, Math.max(0, 1 - remainingKm / totalKm)) : 0.1;
          const etaMin = Math.ceil((remainingKm / effectiveSpeed) * 60);

          await updateOrder(orderId, {
            dronePosition: { ...next, alt },
            progress: prog,
            etaMinutes: etaMin,
            missionPhase: phase,
            drone: { ...(o.drone || {}), speedKmph: Math.round(effectiveSpeed), battery: Math.max(0, battery) },
            telemetry: { ...tel, altitude: alt, heading: Math.round(brng), groundSpeed: Math.round(effectiveSpeed), verticalSpeed: 0, sensorBubble: { active: true, radiusM: SENSOR_BUBBLE_M, obstacleDetected: sensorObstacle }, signalStrength: 90 + Math.round(Math.random() * 10), gpsAccuracy: 0.8 + Math.random() * 1.5, basketState: "closed" },
          });
          try { if (o.drone?.droneId) await updateDroneByDroneId(o.drone.droneId, { battery: Math.max(0, battery), updatedAt: nowIso() }); } catch {}
          break;
        }

        // ------- DESCENDING TO PICKUP -------
        case "descending_pickup": {
          alt = Math.max(0, alt - altStepM);
          battery -= 0.1;
          if (alt <= 0) {
            alt = 0;
            phase = "landed_pickup";
            basketTicks = BASKET_OPEN_TICKS;
            await appendEvent(orderId, mkEvent("mission", "🛬 Landed at pickup point. Opening basket front for loading."));
          }
          await updateOrder(orderId, {
            dronePosition: { lat: pickup.lat, lng: pickup.lng, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: -VERTICAL_SPEED_MPS, groundSpeed: 0, basketState: "closed", signalStrength: 95 + Math.round(Math.random() * 5) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        // ------- LANDED AT PICKUP: BASKET OPEN -------
        case "landed_pickup": {
          basketTicks--;
          if (basketTicks <= 0) {
            await appendEvent(orderId, mkEvent("mission", "📂 Basket front open. Waiting for customer to load package."));
            await updateOrder(orderId, {
              status: "awaiting_load",
              missionPhase: "awaiting_load",
              progress: 0.25,
              awaitingLoadSince: Date.now(),
              loadTimeoutAlert: false,
              dronePosition: { lat: pickup.lat, lng: pickup.lng, alt: 0 },
              telemetry: { ...tel, altitude: 0, verticalSpeed: 0, groundSpeed: 0, basketState: "open_front", signalStrength: 98 },
            });
            const updated = await fsFindOne(ordersCol, { _id: orderId });
            wsBroadcastPendingOrders(updated.customerId);
            await stopSimulation(orderId);
            return;
          }
          await updateOrder(orderId, {
            dronePosition: { lat: pickup.lat, lng: pickup.lng, alt: 0 },
            missionPhase: phase,
            telemetry: { ...tel, altitude: 0, verticalSpeed: 0, groundSpeed: 0, basketState: "opening", signalStrength: 98 },
          });
          break;
        }

        // ------- ASCENDING FROM PICKUP -------
        case "ascending_pickup": {
          alt = Math.min(CRUISE_ALT_M, alt + altStepM);
          battery -= 0.15;
          if (alt >= CRUISE_ALT_M) {
            phase = "to_delivery";
            await appendEvent(orderId, mkEvent("mission", `✈️ Cruising altitude reached: ${CRUISE_ALT_M}m. Heading to delivery point.`));
          }
          await updateOrder(orderId, {
            dronePosition: { ...from, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: VERTICAL_SPEED_MPS, groundSpeed: 0, basketState: "closed", signalStrength: 95 + Math.round(Math.random() * 5) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        // ------- FLYING TO DELIVERY -------
        case "to_delivery": {
          const target = delivery;
          const distKm = haversineKm(from.lat, from.lng, target.lat, target.lng);
          const brng = bearingDeg(from.lat, from.lng, target.lat, target.lng);
          const wFactor = weatherSpeedFactor(weatherNow, brng);
          const effectiveSpeed = droneSpeed * wFactor;
          const stepKm = Math.max(0.02, (effectiveSpeed / 3600) * (tickMs / 1000));

          // Proximity sensor
          let sensorObstacle = false;
          if (!obstacleAvoidanceActive) {
            // Check for other active drones within 50m
            let nearbyDrone = false;
            try {
              const distToTarget = haversineKm(from.lat, from.lng, target.lat, target.lng);
              if (distToTarget > 0.15) { // Only check if > 150m from target
                const activeSimOrders = await fsFind(ordersCol, { status: { $in: ["in_transit", "returning", "accepted"] } });
                for (const aOrder of activeSimOrders) {
                  if (aOrder._id === orderId) continue;
                  if (aOrder.dronePosition) {
                    const d = haversineKm(from.lat, from.lng, aOrder.dronePosition.lat, aOrder.dronePosition.lng);
                    if (d <= 0.05) { // 50m
                      nearbyDrone = true;
                      break;
                    }
                  }
                }
              }
            } catch (e) {}

            if (nearbyDrone || Math.random() < OBSTACLE_CHANCE) {
              obstacleAvoidanceActive = true;
              sensorObstacle = true;
              const offBrng = brng + (Math.random() > 0.5 ? 90 : -90);
              avoidanceOffset = moveKm(from.lat, from.lng, offBrng, 0.1);
              const msg = nearbyDrone ? "🔴 Proximity sensor: nearby drone detected! Executing avoidance maneuver." : "🔴 Proximity sensor: obstacle detected! Executing avoidance maneuver.";
              await appendEvent(orderId, mkEvent("sensor", msg));
              await updateOrder(orderId, { obstacleCount: (o.obstacleCount || 0) + 1 });
            }
          }

          let next;
          if (obstacleAvoidanceActive && avoidanceOffset) {
            const avDist = haversineKm(from.lat, from.lng, avoidanceOffset.lat, avoidanceOffset.lng);
            if (avDist < 0.05) {
              obstacleAvoidanceActive = false;
              avoidanceOffset = null;
              await appendEvent(orderId, mkEvent("sensor", "✅ Obstacle avoided. Resuming route."));
              next = moveKm(from.lat, from.lng, brng, Math.min(stepKm, distKm));
            } else {
              const avBrng = bearingDeg(from.lat, from.lng, avoidanceOffset.lat, avoidanceOffset.lng);
              next = moveKm(from.lat, from.lng, avBrng, Math.min(stepKm, avDist));
            }
          } else {
            next = moveKm(from.lat, from.lng, brng, Math.min(stepKm, distKm));
          }

          // No-fly zone check
          const nfzHit = pointNearNoFlyZone(next.lat, next.lng, 0.3);
          if (nfzHit) {
            const devBrng = brng + 90;
            next = moveKm(from.lat, from.lng, devBrng, stepKm);
            if (!o.nfzWarned) {
              await appendEvent(orderId, mkEvent("safety", `🚫 No-fly zone proximity: ${nfzHit.zone.name}. Deviating route.`));
              await updateOrder(orderId, { nfzWarned: true });
            }
          }

          const reached = haversineKm(next.lat, next.lng, target.lat, target.lng) <= 0.03;
          const drain = batteryDrainPerKm(o.deliveryType) * weatherBatteryFactor(weatherNow) * stepKm;
          battery = Math.max(0, battery - drain);

          if (reached) {
            phase = "descending_delivery";
            await appendEvent(orderId, mkEvent("mission", "📍 Arrived at delivery area. Descending to ground level."));
            next = { lat: target.lat, lng: target.lng };
          }

          const totalKm = totalRouteKm(baseNow, pickup, delivery);
          const remainingKm = haversineKm(next.lat, next.lng, delivery.lat, delivery.lng) + haversineKm(delivery.lat, delivery.lng, baseNow.lat, baseNow.lng);
          const prog = totalKm > 0 ? Math.min(0.999, Math.max(0, 1 - remainingKm / totalKm)) : 0.5;
          const etaMin = Math.ceil((remainingKm / effectiveSpeed) * 60);

          await updateOrder(orderId, {
            dronePosition: { ...next, alt },
            progress: prog,
            etaMinutes: etaMin,
            missionPhase: phase,
            drone: { ...(o.drone || {}), speedKmph: Math.round(effectiveSpeed), battery: Math.max(0, battery) },
            telemetry: { ...tel, altitude: alt, heading: Math.round(brng), groundSpeed: Math.round(effectiveSpeed), verticalSpeed: 0, sensorBubble: { active: true, radiusM: SENSOR_BUBBLE_M, obstacleDetected: sensorObstacle }, signalStrength: 90 + Math.round(Math.random() * 10), gpsAccuracy: 0.8 + Math.random() * 1.5, basketState: "closed" },
          });
          try { if (o.drone?.droneId) await updateDroneByDroneId(o.drone.droneId, { battery: Math.max(0, battery), updatedAt: nowIso() }); } catch {}
          break;
        }

        // ------- DESCENDING TO DELIVERY -------
        case "descending_delivery": {
          alt = Math.max(0, alt - altStepM);
          battery -= 0.1;
          if (alt <= 0) {
            alt = 0;
            phase = "landed_delivery";
            basketTicks = BASKET_OPEN_TICKS;
            await appendEvent(orderId, mkEvent("mission", "🛬 Landed at delivery point. Opening basket bottom to release package."));
          }
          await updateOrder(orderId, {
            dronePosition: { lat: delivery.lat, lng: delivery.lng, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: -VERTICAL_SPEED_MPS, groundSpeed: 0, basketState: "closed", signalStrength: 95 + Math.round(Math.random() * 5) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        // ------- LANDED AT DELIVERY: PACKAGE DROP -------
        case "landed_delivery": {
          basketTicks--;
          if (basketTicks <= 2 && basketTicks > 0) {
            await updateOrder(orderId, {
              telemetry: { ...tel, altitude: 0, basketState: "open_bottom", signalStrength: 98 },
            });
            if (basketTicks === 2) await appendEvent(orderId, mkEvent("mission", "📦 Basket bottom opening... Package being released."));
          } else if (basketTicks <= 0) {
            await appendEvent(orderId, mkEvent("mission", "✅ Package delivered safely on ground. Basket closing."));
            phase = "ascending_delivery";
            await updateOrder(orderId, {
              missionPhase: phase,
              dronePosition: { lat: delivery.lat, lng: delivery.lng, alt: 0 },
              telemetry: { ...tel, altitude: 0, basketState: "closing", signalStrength: 98 },
            });
          } else {
            await updateOrder(orderId, {
              dronePosition: { lat: delivery.lat, lng: delivery.lng, alt: 0 },
              telemetry: { ...tel, altitude: 0, basketState: "opening_bottom", signalStrength: 98 },
            });
          }
          break;
        }

        // ------- ASCENDING FROM DELIVERY -------
        case "ascending_delivery": {
          alt = Math.min(CRUISE_ALT_M, alt + altStepM);
          battery -= 0.15;

          // Basket closing sequence: open_bottom while near ground, closing at ~5m, closed at ~8m
          let bState = "open_bottom";
          if (alt >= 8) {
            bState = "closed";
          } else if (alt >= 5) {
            if (!o._basketClosingLogged) {
              await appendEvent(orderId, mkEvent("mission", "🔒 Basket closing at safe altitude above package."));
              await updateOrder(orderId, { _basketClosingLogged: true });
            }
            bState = "closing";
          }

          if (alt >= CRUISE_ALT_M) {
            phase = "returning";
            bState = "closed";
            await appendEvent(orderId, mkEvent("mission", `✈️ Altitude ${CRUISE_ALT_M}m reached. Basket secured. Returning to base.`));
            await updateOrder(orderId, { status: "returning" });
          }
          await updateOrder(orderId, {
            dronePosition: { lat: delivery.lat, lng: delivery.lng, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: VERTICAL_SPEED_MPS, groundSpeed: 0, basketState: bState, signalStrength: 95 + Math.round(Math.random() * 5) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        // ------- RETURNING TO BASE -------
        case "returning": {
          const target = baseNow;
          const distKm = haversineKm(from.lat, from.lng, target.lat, target.lng);
          const brng = bearingDeg(from.lat, from.lng, target.lat, target.lng);
          const wFactor = weatherSpeedFactor(weatherNow, brng);
          const effectiveSpeed = droneSpeed * wFactor;
          const stepKm = Math.max(0.02, (effectiveSpeed / 3600) * (tickMs / 1000));

          // Proximity sensor during return
          let sensorObstacle = false;
          if (!obstacleAvoidanceActive) {
            // Check for other active drones within 50m
            let nearbyDrone = false;
            try {
              const distToTarget = haversineKm(from.lat, from.lng, target.lat, target.lng);
              if (distToTarget > 0.15) { // Only check if > 150m from target
                const activeSimOrders = await fsFind(ordersCol, { status: { $in: ["in_transit", "returning", "accepted"] } });
                for (const aOrder of activeSimOrders) {
                  if (aOrder._id === orderId) continue;
                  if (aOrder.dronePosition) {
                    const d = haversineKm(from.lat, from.lng, aOrder.dronePosition.lat, aOrder.dronePosition.lng);
                    if (d <= 0.05) { // 50m
                      nearbyDrone = true;
                      break;
                    }
                  }
                }
              }
            } catch (e) {}

            if (nearbyDrone || Math.random() < OBSTACLE_CHANCE) {
              obstacleAvoidanceActive = true;
              sensorObstacle = true;
              const offBrng = brng + (Math.random() > 0.5 ? 90 : -90);
              avoidanceOffset = moveKm(from.lat, from.lng, offBrng, 0.1);
              const msg = nearbyDrone ? "🔴 Proximity sensor: nearby drone detected during return! Executing avoidance." : "🔴 Proximity sensor: obstacle detected during return!";
              await appendEvent(orderId, mkEvent("sensor", msg));
              await updateOrder(orderId, { obstacleCount: (o.obstacleCount || 0) + 1 });
            }
          }

          let next;
          if (obstacleAvoidanceActive && avoidanceOffset) {
            const avDist = haversineKm(from.lat, from.lng, avoidanceOffset.lat, avoidanceOffset.lng);
            if (avDist < 0.05) {
              obstacleAvoidanceActive = false;
              avoidanceOffset = null;
              await appendEvent(orderId, mkEvent("sensor", "✅ Obstacle avoided. Resuming return."));
              next = moveKm(from.lat, from.lng, brng, Math.min(stepKm, distKm));
            } else {
              const avBrng = bearingDeg(from.lat, from.lng, avoidanceOffset.lat, avoidanceOffset.lng);
              next = moveKm(from.lat, from.lng, avBrng, Math.min(stepKm, avDist));
            }
          } else {
            next = moveKm(from.lat, from.lng, brng, Math.min(stepKm, distKm));
          }

          const reached = haversineKm(next.lat, next.lng, target.lat, target.lng) <= 0.03;
          const drain = batteryDrainPerKm(o.deliveryType) * weatherBatteryFactor(weatherNow) * stepKm;
          battery = Math.max(0, battery - drain);

          if (reached) {
            phase = "descending_base";
            await appendEvent(orderId, mkEvent("mission", "📍 Base in range. Descending for landing."));
            next = { lat: target.lat, lng: target.lng };
          }

          const remainingKm = haversineKm(next.lat, next.lng, baseNow.lat, baseNow.lng);
          const totalKm = totalRouteKm(baseNow, pickup, delivery);
          const prog = totalKm > 0 ? Math.min(0.999, Math.max(0, 1 - remainingKm / totalKm)) : 0.8;
          const etaMin = Math.ceil((remainingKm / effectiveSpeed) * 60);

          if (battery <= 20 && !o.lowBatteryWarned) {
            await appendEvent(orderId, mkEvent("warning", "⚠️ Low battery: drone under 20%."));
            await updateOrder(orderId, { lowBatteryWarned: true });
          }

          await updateOrder(orderId, {
            dronePosition: { ...next, alt },
            progress: prog,
            etaMinutes: etaMin,
            missionPhase: phase,
            drone: { ...(o.drone || {}), speedKmph: Math.round(effectiveSpeed), battery: Math.max(0, battery) },
            telemetry: { ...tel, altitude: alt, heading: Math.round(brng), groundSpeed: Math.round(effectiveSpeed), verticalSpeed: 0, sensorBubble: { active: true, radiusM: SENSOR_BUBBLE_M, obstacleDetected: sensorObstacle }, signalStrength: 90 + Math.round(Math.random() * 10), gpsAccuracy: 0.8 + Math.random() * 1.5, basketState: "closed" },
          });
          try { if (o.drone?.droneId) await updateDroneByDroneId(o.drone.droneId, { battery: Math.max(0, battery), updatedAt: nowIso() }); } catch {}
          break;
        }

        // ------- DESCENDING TO BASE -------
        case "descending_base": {
          alt = Math.max(0, alt - altStepM);
          battery -= 0.1;
          if (alt <= 0) {
            alt = 0;
            // ===== MISSION COMPLETE =====
            const isRecallFinalize = o.recall && o.recall.finalizeAs === "cancelled";

            if (isRecallFinalize) {
              await updateOrder(orderId, { status: "cancelled", missionPhase: "recalled_complete", progress: 1, dronePosition: { lat: baseNow.lat, lng: baseNow.lng, alt: 0 }, etaMinutes: 0, telemetry: { ...tel, altitude: 0, verticalSpeed: 0, groundSpeed: 0, basketState: "closed", signalStrength: 99 } });
              await appendEvent(orderId, mkEvent("mission", "🛬 Recall complete: drone landed at base. Order cancelled."));
            } else {
              await updateOrder(orderId, { status: "delivered", missionPhase: "complete", progress: 1, dronePosition: { lat: baseNow.lat, lng: baseNow.lng, alt: 0 }, etaMinutes: 0, telemetry: { ...tel, altitude: 0, verticalSpeed: 0, groundSpeed: 0, basketState: "closed", signalStrength: 99 } });

              try {
                const finalDoc = await fsFindOne(ordersCol, { _id: orderId });
                if (finalDoc) {
                  const deliveredAt = Date.now();
                  const createdAtMs = finalDoc.createdAt ? new Date(finalDoc.createdAt).getTime() : null;
                  const actualMinutes = createdAtMs ? Math.max(1, (deliveredAt - createdAtMs) / 60000) : null;
                  
                  // Compute true flight minutes
                  const totalLoadingMinutes = (finalDoc.totalLoadingTimeMs || 0) / 60000;
                  const flightMinutes = actualMinutes ? Math.max(1, actualMinutes - totalLoadingMinutes) : null;
                  
                  await fsUpdate(ordersCol, orderId, { deliveredAt, actualMinutes, flightMinutes });
                }
              } catch {}

              await appendEvent(orderId, mkEvent("mission", "🛬 Mission complete: drone safely landed at base."));
              for (const c of wsClients) { wsSend(c.socket, { type: "delivery_completed", orderId }); }
            }

            try {
              const finalDoc = await fsFindOne(ordersCol, { _id: orderId });
              const droneId = finalDoc?.drone?.droneId;
              const batt = finalDoc?.drone?.battery;
              if (droneId) await releaseDrone(droneId, { battery: typeof batt === "number" ? batt : undefined });
            } catch {}

            return stopSimulation(orderId);
          }

          await updateOrder(orderId, {
            dronePosition: { lat: baseNow.lat, lng: baseNow.lng, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: -VERTICAL_SPEED_MPS, groundSpeed: 0, basketState: "closed", signalStrength: 95 + Math.round(Math.random() * 5) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        // ------- EMERGENCY LANDING -------
        case "emergency_landing": {
          alt = Math.max(0, alt - altStepM * 1.5); // faster descent in emergency
          if (alt <= 0) {
            alt = 0;
            await appendEvent(orderId, mkEvent("safety", "🔴 Emergency landing completed at current position."));
            await updateOrder(orderId, { status: "cancelled", missionPhase: "emergency_landed", dronePosition: { ...from, alt: 0 }, telemetry: { ...tel, altitude: 0, verticalSpeed: 0, groundSpeed: 0, signalStrength: 50 } });
            try {
              if (o.drone?.droneId) await releaseDrone(o.drone.droneId, { battery: Math.max(0, battery) });
            } catch {}
            return stopSimulation(orderId);
          }
          await updateOrder(orderId, {
            dronePosition: { ...from, alt },
            missionPhase: phase,
            telemetry: { ...tel, altitude: alt, verticalSpeed: -(VERTICAL_SPEED_MPS * 1.5), groundSpeed: 0, signalStrength: 30 + Math.round(Math.random() * 20) },
            drone: { ...(o.drone || {}), speedKmph: 0, battery: Math.max(0, battery) },
          });
          break;
        }

        default: {
          // Unknown phase, try returning
          phase = "returning";
          await updateOrder(orderId, { missionPhase: phase });
          break;
        }
      }
    } catch (e) {
      console.error("[SIM]", e);
      await stopSimulation(orderId);
    }
  }, tickMs);

  sim.set(orderId, handle);
}

// ===== Routes =====
app.get("/api/health", (req, res) => res.json({ ok: true, time: nowIso(), version: "A-ready-ws" }));

// --- Weather API (public) ---
app.get("/api/weather/:lat/:lng", async (req, res) => {
  try {
    const lat = parseFloat(req.params.lat);
    const lng = parseFloat(req.params.lng);
    if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: "Invalid coordinates." });
    const weather = await fetchWeatherForCoords(lat, lng);
    res.json(weather);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

// --- Geofencing / No-Fly Zones (public) ---
app.get("/api/geofence/zones", (req, res) => {
  res.json(NO_FLY_ZONES);
});

// --- Auth --- @AridaniDahlGuerra @AssaadMohammadAatfaYamlik
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    const uname = String(username).trim().toLowerCase();
    const exists = await fsFindOne(usersCol, { username: uname });
    if (exists) return res.status(409).json({ error: "Username already exists." });

    const salt = id(16);
    const passwordHash = hashPassword(String(password), salt);
    const user = await fsInsert(usersCol, {
      username: uname,
      role: "customer",
      salt,
      passwordHash,
      createdAt: nowIso(),
    });

    const token = issueToken(user._id, user.role);
    res.status(201).json({ token, user: { id: user._id, username: user.username, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Missing credentials." });

    const uname = String(username).trim().toLowerCase();
    const user = await fsFindOne(usersCol, { username: uname });
    if (!user) return res.status(401).json({ error: "Invalid username or password." });

    const attempt = hashPassword(String(password), user.salt);
    if (attempt !== user.passwordHash) return res.status(401).json({ error: "Invalid username or password." });

    const token = issueToken(user._id, user.role);
    res.json({ token, user: { id: user._id, username: user.username, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await fsFindOne(usersCol, { _id: req.user.id });
  if (!user) return res.status(401).json({ error: "Invalid session." });
  res.json({ id: user._id, username: user.username, role: user.role });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer (.+)$/i);
  const token = m ? m[1] : null;
  if (token) authTokens.delete(token);
  res.json({ ok: true });
});

// --- Drone fleet (admin) --- @AridaniDahlGuerra
app.get("/api/drones", requireAdmin, async (req, res) => {
  try {
    await ensureSeedDrones();
    let drones = await fsFind(dronesCol, {});
    drones.sort((a, b) => String(a.droneId).localeCompare(String(b.droneId)));

    // Merge live mission data from active orders
    const activeOrders = await fsFind(ordersCol, { status: { $in: ["in_transit", "returning", "awaiting_load", "accepted"] } });
    const missionByDrone = {};
    for (const o of activeOrders) {
      if (o.drone?.droneId) {
        missionByDrone[o.drone.droneId] = {
          orderId: o._id,
          missionPhase: o.missionPhase,
          orderStatus: o.status,
          battery: o.drone?.battery,
        };
      }
    }

    const out = drones.map((d) => {
      const mission = missionByDrone[d.droneId];
      const batt = typeof (mission?.battery ?? d.battery) === "number" ? (mission?.battery ?? d.battery) : 0;
      const displayStatus = d.status === "assigned" && mission
        ? (mission.orderStatus === "in_transit" ? "in flight" : mission.orderStatus === "returning" ? "returning" : mission.orderStatus)
        : d.status;
      return {
        droneId: d.droneId,
        droneType: d.droneType || "light",
        status: displayStatus,
        battery: batt,
        assignedOrderId: d.assignedOrderId || null,
        missionPhase: mission?.missionPhase || null,
        remoteId: d.remoteId || null,
        rangeKmLight: approxRangeKmFromBattery(batt, "light"),
        rangeKmHeavy: approxRangeKmFromBattery(batt, "heavy"),
        rangeKmLongrange: approxRangeKmFromBattery(batt, "longrange"),
      };
    });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/drones/:id/recharge", requireAdmin, async (req, res) => {
  try {
    const droneId = String(req.params.id || "").trim();
    const d = await fsFindOne(dronesCol, { droneId });
    if (!d) return res.status(404).json({ error: "Drone not found." });
    if (d.status === "assigned") return res.status(400).json({ error: "Drone is assigned to an order. Release it first." });
    stopCharging(droneId);
    await updateDroneByDroneId(droneId, { battery: 100, status: "idle", updatedAt: nowIso() });
    const updated = await fsFindOne(dronesCol, { droneId });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

// --- Orders --- @ShazebAyubAlam @AssaadMohammadAatfaYamlik
app.post("/api/orders", requireCustomer, async (req, res) => {
  try {
    const { customerName, phone, email, base, pickup, delivery, packageWeightKg, deliveryType, notes, packageDimensions } = req.body || {};

    if (!customerName || !phone || !pickup || !delivery) return res.status(400).json({ error: "Missing required fields." });
    if (typeof pickup.lat !== "number" || typeof pickup.lng !== "number" || typeof delivery.lat !== "number" || typeof delivery.lng !== "number") {
      return res.status(400).json({ error: "Pickup/Delivery must include numeric lat/lng." });
    }

    // No-fly zone check for pickup and delivery
    const pickupNfz = pointInNoFlyZone(pickup.lat, pickup.lng);
    if (pickupNfz) {
      return res.status(400).json({ error: `Pickup point is inside no-fly zone: ${pickupNfz.name}. Please choose a different pickup location.` });
    }
    const deliveryNfz = pointInNoFlyZone(delivery.lat, delivery.lng);
    if (deliveryNfz) {
      return res.status(400).json({ error: `Delivery point is inside no-fly zone: ${deliveryNfz.name}. Please choose a different delivery location.` });
    }

    // Validate package dimensions
    const pkgL = Number(packageDimensions?.lengthCm || 0);
    const pkgW = Number(packageDimensions?.widthCm || 0);
    const pkgH = Number(packageDimensions?.heightCm || 0);
    if (pkgL <= 0 || pkgW <= 0 || pkgH <= 0) {
      return res.status(400).json({ error: "Package dimensions (length, width, height in cm) are required." });
    }

    // Check if the package fits in the selected drone type's basket
    const selectedType = deliveryType || "light";
    if (!packageFitsBasket(pkgL, pkgW, pkgH, selectedType)) {
      const fitting = findFittingBasketTypes(pkgL, pkgW, pkgH);
      if (fitting.length === 0) {
        return res.status(400).json({
          error: `Package (${pkgL}×${pkgW}×${pkgH} cm) is too large for any drone basket. Max basket: ${BASKET_DIMENSIONS.heavy.label}.`,
        });
      }
      return res.status(400).json({
        error: `Package (${pkgL}×${pkgW}×${pkgH} cm) does not fit in ${selectedType} drone basket (${BASKET_DIMENSIONS[selectedType]?.label}). Try: ${fitting.join(", ")}.`,
      });
    }

    const basePoint =
      base && typeof base.lat === "number" && typeof base.lng === "number" ? { lat: base.lat, lng: base.lng } : { lat: pickup.lat, lng: pickup.lng };

    const totalKm = totalRouteKm(basePoint, pickup, delivery);

    const loadingBufferMin = 2;
    const flightTimeMin = Math.ceil((totalKm / speedKmph(deliveryType || "standard")) * 60);
    const etaMinutes = flightTimeMin + loadingBufferMin;

    await ensureSeedDrones();
    const chosenDrone = await pickAvailableDroneForOrder(totalKm, deliveryType || "standard");
    if (!chosenDrone) {
      return res.status(400).json({
        error:
          "No available drones with enough battery for the full trip (base → pickup → delivery → base). Try again later or choose a shorter route.",
      });
    }

    const order = {
      customerId: req.user.id,
      customerName,
      phone,
      email: email || "",
      base: basePoint,
      pickup,
      delivery,
      packageWeightKg: Number(packageWeightKg || 0),
      packageDimensions: { lengthCm: pkgL, widthCm: pkgW, heightCm: pkgH },
      deliveryType: deliveryType || "light",
      notes: notes || "",
      status: "awaiting_payment",
      missionPhase: "idle",
      progress: 0,
      etaMinutes,
      etaSource: "rule",
      routeDistanceKm: totalKm,
      estimate: { km: totalKm, priceNok: null },
      dronePosition: { lat: basePoint.lat, lng: basePoint.lng },
      drone: {
        droneId: chosenDrone.droneId,
        battery: typeof chosenDrone.battery === "number" ? chosenDrone.battery : 100,
        speedKmph: speedKmph(deliveryType || "light"),
        approxRangeKm: approxRangeKmFromBattery(chosenDrone.battery ?? 100, deliveryType || "light"),
      },
      events: [mkEvent("order", "Order created – awaiting payment.")],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // Calculate price from services.json if available
    try {
      const fs = require("fs");
      const servicesPath = require("path").join(__dirname, "public", "assets", "services.json");
      const servicesData = JSON.parse(fs.readFileSync(servicesPath, "utf8"));
      const svc = (servicesData.deliveryTypes || []).find(t => t.id === (deliveryType || "light"));
      if (svc) {
        const wkg = Number(packageWeightKg || 0);
        order.estimate.priceNok = Math.round(svc.baseNok + svc.perKmNok * totalKm + Math.max(0, wkg - 1) * 12);
      }
    } catch (e) {
      console.error("[PRICE]", e.message);
    }

    const inserted = await fsInsert(ordersCol, order);
    // Don't assign drone or auto-start yet – wait for payment

    const finalDoc = await fsFindOne(ordersCol, { _id: inserted._id });
    if (finalDoc) wsBroadcastOrder(finalDoc);
    res.status(201).json(finalDoc || inserted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// --- Pay order (simulated payment) --- @ShazebAyubAlam
app.post("/api/orders/:id/pay", requireCustomer, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Order not found." });
    if (o.customerId !== req.user.id) return res.status(403).json({ error: "Not your order." });
    if (o.status !== "awaiting_payment") return res.status(400).json({ error: "Order is not awaiting payment." });

    // Mark as paid and transition to in_transit
    const payEvents = Array.isArray(o.events) ? [...o.events, mkEvent("payment", "Payment received – drone dispatched.")] : [mkEvent("payment", "Payment received – drone dispatched.")];
    await fsUpdate(ordersCol, o._id, { status: "in_transit", updatedAt: nowIso(), events: payEvents });

    // Now assign drone and auto-start
    if (o.drone?.droneId) {
      await assignDroneToOrder(o._id, o.drone.droneId);
      try {
        await startSimulation(o._id);
      } catch (e) {
        console.error("[PAY-AUTO-START]", e.message || e);
      }
    }

    const updated = await fsFindOne(ordersCol, { _id: o._id });
    if (updated) wsBroadcastOrder(updated);
    res.json({ ok: true, order: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// --- Abandon unpaid order (delete completely) ---
app.post("/api/orders/:id/abandon", requireCustomer, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Order not found." });
    if (o.customerId !== req.user.id) return res.status(403).json({ error: "Not your order." });
    if (o.status !== "awaiting_payment") return res.status(400).json({ error: "Cannot abandon a paid order." });

    // Remove the order entirely
    await fsRemove(ordersCol, o._id);
    console.log(`[ABANDON] Order ${o._id} deleted by customer (unpaid).`);
    res.json({ ok: true, deleted: o._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const { q, status, sort } = req.query;
    const baseQuery = req.user.role === "admin" ? {} : { customerId: req.user.id };
    let orders = await fsFind(ordersCol, baseQuery);
    orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    if (status && status !== "all") orders = orders.filter((o) => o.status === status);

    if (q) {
      const needle = String(q).toLowerCase();
      orders = orders.filter(
        (o) =>
          String(o._id).toLowerCase().includes(needle) ||
          String(o.customerName).toLowerCase().includes(needle) ||
          String(o.phone).toLowerCase().includes(needle) ||
          String(o.pickup?.label || "").toLowerCase().includes(needle) ||
          String(o.delivery?.label || "").toLowerCase().includes(needle)
      );
    }
    if (sort === "eta") orders.sort((a, b) => (a.etaMinutes ?? 9999) - (b.etaMinutes ?? 9999));

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/orders/:id", requireAuth, async (req, res) => {
  try {
    const order = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!order) return res.status(404).json({ error: "Not found." });
    if (req.user.role !== "admin" && order.customerId !== req.user.id) return res.status(403).json({ error: "Not allowed." });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/orders/:id/accept", requireAdmin, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });
    if (o.status !== "created") return res.status(400).json({ error: "Only 'created' orders can be accepted." });

    const updated = await updateOrder(req.params.id, { status: "accepted" });
    await appendEvent(req.params.id, mkEvent("order", "Order accepted by operator."));
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/orders/:id/cancel", requireAdmin, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });

    const updated = await updateOrder(req.params.id, { status: "cancelled", missionPhase: "cancelled" });
    await appendEvent(req.params.id, mkEvent("order", "Order cancelled by operator."));
    await stopSimulation(req.params.id);
    try {
      const droneId = o.drone?.droneId;
      if (droneId) await releaseDrone(droneId, { battery: typeof o.drone?.battery === "number" ? o.drone.battery : undefined });
    } catch {}
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/orders/:id/recall", requireAdmin, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });

    if (!(o.status === "awaiting_load" && o.missionPhase === "awaiting_load")) return res.status(400).json({ error: "Order is not waiting at pickup." });

    const charged = typeof o.estimate?.priceNok === "number" ? o.estimate.priceNok : null;
    await appendEvent(
      o._id,
      mkEvent("mission", `Drone recalled: customer did not load package. Returning to base. ${charged != null ? `Customer charged estimate: ${charged} NOK.` : ""}`)
    );

    const updated = await updateOrder(o._id, {
      status: "returning",
      missionPhase: "returning",
      recall: { at: nowIso(), reason: "customer_no_load", chargedNok: charged, finalizeAs: "cancelled" },
    });

    try {
      await startSimulation(o._id);
    } catch (e) {
      console.error("[RECALL] startSimulation failed:", e?.message || e);
      await appendEvent(o._id, mkEvent("warning", "Recall accepted, but simulator failed to start. Tracking may not update in real-time."));
    }

    wsBroadcastOrder(updated);
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/orders/:id/customer_recall", requireCustomer, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });
    if (o.customerId !== req.user.id) return res.status(403).json({ error: "Not your order." });

    if (!(o.status === "awaiting_load" && o.missionPhase === "awaiting_load")) return res.status(400).json({ error: "Order is not waiting at pickup." });

    const charged = typeof o.estimate?.priceNok === "number" ? o.estimate.priceNok : null;
    await appendEvent(
      o._id,
      mkEvent("mission", `Customer manually cancelled order at pickup. Returning to base. ${charged != null ? `Customer charged estimate: ${charged} NOK.` : ""}`)
    );

    const updated = await updateOrder(o._id, {
      status: "returning",
      missionPhase: "returning",
      recall: { at: nowIso(), reason: "customer_cancel_at_pickup", chargedNok: charged, finalizeAs: "cancelled" },
    });

    try {
      await startSimulation(o._id);
    } catch (e) {
      console.error("[CUSTOMER RECALL] startSimulation failed:", e?.message || e);
    }

    wsBroadcastOrder(updated);
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/orders/:id/start", requireAdmin, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });
    if (!(o.status === "accepted" || o.status === "created")) return res.status(400).json({ error: "Order must be created/accepted to start mission." });

    await startSimulation(req.params.id);
    const updated = await fsFindOne(ordersCol, { _id: req.params.id });
    wsBroadcastOrder(updated);
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Could not start mission." });
  }
});

app.post("/api/orders/:id/stop", requireAdmin, async (req, res) => {
  try {
    await stopSimulation(req.params.id);
    await appendEvent(req.params.id, mkEvent("mission", "Mission paused by operator."));
    const updated = await updateOrder(req.params.id, { status: "accepted", missionPhase: "paused" });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/orders/:id/customer_start", requireCustomer, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });
    if (o.customerId !== req.user.id) return res.status(403).json({ error: "Not allowed." });
    if (o.status !== "awaiting_load" || o.missionPhase !== "awaiting_load") return res.status(400).json({ error: "Order is not waiting at pickup." });

    const base = orderBase(o);
    const remainingKm =
      haversineKm(o.pickup.lat, o.pickup.lng, o.delivery.lat, o.delivery.lng) + haversineKm(o.delivery.lat, o.delivery.lng, base.lat, base.lng);
    const need = requiredBatteryPctForTrip(remainingKm, o.deliveryType);
    const batt = typeof o.drone?.battery === "number" ? o.drone.battery : 100;
    if (batt < need) {
      await appendEvent(o._id, mkEvent("warning", "Cannot start delivery: insufficient battery for remaining route."));
      return res.status(400).json({ error: "Dronen har ikke nok batteri til å fullføre levering og retur til basen." });
    }

    const loadingTimeMs = o.awaitingLoadSince ? (Date.now() - o.awaitingLoadSince) : 0;
    const existingWait = o.totalLoadingTimeMs || 0;
    await updateOrder(o._id, { status: "in_transit", missionPhase: "awaiting_load", dronePosition: { lat: o.pickup.lat, lng: o.pickup.lng }, loadTimeoutAlert: false, totalLoadingTimeMs: existingWait + loadingTimeMs });
    await startSimulation(o._id);
    const updated = await fsFindOne(ordersCol, { _id: o._id });
    wsBroadcastPendingOrders(updated.customerId);
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Could not start delivery." });
  }
});

app.get("/api/orders/:id/events", requireAuth, async (req, res) => {
  try {
    const o = await fsFindOne(ordersCol, { _id: req.params.id });
    if (!o) return res.status(404).json({ error: "Not found." });
    if (req.user.role !== "admin" && o.customerId !== req.user.id) return res.status(403).json({ error: "Not allowed." });
    res.json(Array.isArray(o.events) ? o.events : []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

// ===================== CONTACTS & NAV BADGES ===================== @Anwar
async function getPendingOrdersCount(userId) {
  if (!userId) return 0;
  return await fsCount(ordersCol, {
    customerId: userId,
    $or: [{ status: "in_transit" }, { status: "awaiting_load" }],
    missionPhase: "awaiting_load"
  });
}

async function wsBroadcastPendingOrders(userId) {
  try {
    const count = await getPendingOrdersCount(userId);
    for (const c of wsClients) {
      if (c.user && c.user.id === userId) {
        wsSend(c.socket, { type: "pending_orders_count", count });
      }
    }
  } catch (e) {
    console.error("[PendingOrdersBroadcast]", e.message);
  }
}

app.get("/api/orders/pending-count", requireCustomer, async (req, res) => {
  try {
    const count = await getPendingOrdersCount(req.user.id);
    res.json({ count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

// (Optional) simple migration for older docs
async function ensureContactsFlags() {
  try {
    const all = await fsFind(contactsCol, {});
    for (const c of all) {
      const patch = {};
      if (typeof c.adminUnread !== "boolean") patch.adminUnread = !c.adminReply; // unread for admin if no reply yet
      if (typeof c.customerUnread !== "boolean") patch.customerUnread = Boolean(c.adminReply); // unread for customer if there is a reply
      if (Object.keys(patch).length) await fsUpdate(contactsCol, c._id, patch);
    }
  } catch (e) {
    console.warn("[CONTACTS] ensureContactsFlags failed:", e?.message || e);
  }
}

// Customer creates a contact message (must be logged in)
app.post("/api/contacts", requireCustomer, async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ error: "Missing required fields." });

    const doc = await fsInsert(contactsCol, {
      customerId: req.user.id,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      message: String(message).trim(),
      createdAt: nowIso(),
      adminReply: null,
      repliedAt: null,

      // flags
      adminUnread: true,
      customerUnread: false,
    });

    res.status(201).json(doc);

    // notify admins badge
    await wsBroadcastContactsUnread();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Customer reads ONLY their own messages (does NOT auto mark as read)
app.get("/api/contacts/mine", requireCustomer, async (req, res) => {
  try {
    let docs = await fsFind(contactsCol, { customerId: req.user.id });
    docs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json(docs || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Customer marks ALL their admin replies as read
app.post("/api/contacts/mine/mark-read", requireCustomer, async (req, res) => {
  try {
    const myUnread = await fsFind(contactsCol, { customerId: req.user.id, customerUnread: true });
    for (const c of myUnread) { await fsUpdate(contactsCol, c._id, { customerUnread: false }); }
    res.json({ ok: true });

    // push badge update to that customer
    await wsBroadcastContactsUnread({ customerIdAffected: req.user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Admin-only read (all) (does NOT auto mark as read)
app.get("/api/contacts", requireAdmin, async (req, res) => {
  try {
    let contacts = await fsFind(contactsCol, {});
    contacts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json(contacts || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Admin marks one message as read
app.post("/api/contacts/:id/mark-read", requireAdmin, async (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    if (!cid) return res.status(400).json({ error: "Missing id." });

    await fsUpdate(contactsCol, cid, { adminUnread: false });

    const updated = await fsFindOne(contactsCol, { _id: cid });
    if (!updated) return res.status(404).json({ error: "Not found." });

    res.json(updated);

    // admin badge update
    await wsBroadcastContactsUnread();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Admin replies (marks admin read + makes customer unread)
app.post("/api/contacts/:id/reply", requireAdmin, async (req, res) => {
  try {
    const cid = String(req.params.id || "").trim();
    const reply = String(req.body?.reply || "").trim();
    if (!cid) return res.status(400).json({ error: "Missing id." });
    if (!reply) return res.status(400).json({ error: "Missing reply." });

    await fsUpdate(contactsCol, cid, {
      adminReply: reply,
      repliedAt: nowIso(),
      adminUnread: false,
      customerUnread: true,
    });

    const updated = await fsFindOne(contactsCol, { _id: cid });
    if (!updated) return res.status(404).json({ error: "Not found." });

    res.json(updated);

    // push badges
    await wsBroadcastContactsUnread(); // admin
    await wsBroadcastContactsUnread({ customerIdAffected: updated.customerId || null }); // affected customer
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Admin initiates a new message to customer
app.post("/api/contacts/admin-init", requireAdmin, async (req, res) => {
  try {
    const { customerId, name, email, message } = req.body || {};
    if (!message) return res.status(400).json({ error: "Missing message." });

    const doc = await fsInsert(contactsCol, {
      customerId: customerId || "guest",
      name: name || "Customer",
      email: email || "",
      message: "[Admin Init]",
      createdAt: nowIso(),
      adminReply: String(message).trim(),
      repliedAt: nowIso(),
      adminUnread: false,
      customerUnread: true,
    });

    res.status(201).json(doc);
    if (customerId) await wsBroadcastContactsUnread({ customerIdAffected: customerId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Badge count (REST) for nav-badge (admin or customer)
app.get("/api/contacts/unread-count", requireAuth, async (req, res) => {
  try {
    if (req.user.role === "admin") {
      const count = await fsCount(contactsCol, { adminUnread: true });
      return res.json({ count });
    }
    const count = await fsCount(contactsCol, { customerId: req.user.id, customerUnread: true });
    return res.json({ count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// ===== BOOT / START SERVER =====
const fs = require("fs");

async function resumeChargingAll() {
  const drones = await fsFind(dronesCol, {});
  for (const d of drones) {
    if ((d.status === "idle" || d.status === "charging") && (d.battery ?? 100) < 100) {
      await fsUpdate(dronesCol, d._id, { status: "charging", updatedAt: nowIso() });
      startCharging(d.droneId);
    }
  }
  const chargingCount = chargingTimers.size;
  if (chargingCount > 0) console.log(`[CHARGING] Resumed charging for ${chargingCount} drone(s)`);
}

async function startAwaitingLoadCheck() {
  setInterval(async () => {
    try {
      const allWaiting = await fsFind(ordersCol, { status: "awaiting_load" });
      const now = Date.now();
      const LIMIT_MS = 10 * 60 * 1000; // 10 mins
      const AUTO_RECALL_MS = 15 * 60 * 1000; // 15 mins
      
      for (const o of allWaiting) {
        if (!o.awaitingLoadSince) continue;
        const elapsed = now - o.awaitingLoadSince;
        
        if (!o.loadTimeoutAlert && elapsed > LIMIT_MS && elapsed <= AUTO_RECALL_MS) {
          await updateOrder(o._id, { loadTimeoutAlert: true });
          await appendEvent(o._id, mkEvent("safety", "⚠️ Package load time limit (10 mins) exceeded."));
          
          await fsInsert(contactsCol, {
            customerId: o.customerId || "guest",
            name: o.customerName || "Customer",
            email: o.email || "",
            message: "[System Auto-Message]",
            createdAt: nowIso(),
            adminReply: "⚠️ Time limit (10m) exceeded. Please load your package immediately. The drone will automatically return to base in 5 minutes.",
            repliedAt: nowIso(),
            adminUnread: false,
            customerUnread: true,
          });
          if (o.customerId) await wsBroadcastContactsUnread({ customerIdAffected: o.customerId });

        } else if (elapsed > AUTO_RECALL_MS) {
          const charged = typeof o.estimate?.priceNok === "number" ? o.estimate.priceNok : null;
          await appendEvent(
            o._id,
            mkEvent("mission", `Drone auto-recalled: 15-minute wait limit exceeded. Returning to base. ${charged != null ? `Customer charged estimate: ${charged} NOK.` : ""}`)
          );

          const updated = await updateOrder(o._id, {
            status: "returning",
            missionPhase: "returning",
            recall: { at: nowIso(), reason: "timeout_auto_recall", chargedNok: charged, finalizeAs: "cancelled" },
          });
          
          await fsInsert(contactsCol, {
            customerId: o.customerId || "guest",
            name: o.customerName || "Customer",
            email: o.email || "",
            message: "[System Auto-Message]",
            createdAt: nowIso(),
            adminReply: "🛑 Your order was automatically cancelled as the drone wait limit (15m) was exceeded. The drone has returned to base and you have been charged for the mission.",
            repliedAt: nowIso(),
            adminUnread: false,
            customerUnread: true,
          });
          if (o.customerId) await wsBroadcastContactsUnread({ customerIdAffected: o.customerId });

          try { await startSimulation(o._id); } catch (e) {}
          wsBroadcastOrder(updated);
        }
      }
    } catch (err) {
      console.error("[Timeout Check] Error:", err);
    }
  }, 10000); // Check every 10 seconds
}

async function boot() {
  try {
    await ensureBootstrapAdmin();
    await ensureSeedDrones();
    await ensureContactsFlags();
    await resumeChargingAll();
    startAwaitingLoadCheck();

    server.listen(PORT, () => {
      console.log(`DroneDeliver running on http://localhost:${PORT}`);
      console.log(`[AUTH] Default admin: username=admin (password from ADMIN_KEY env)`);
      console.log(`[WS] WebSocket endpoint: ws://localhost:${PORT}/ws?token=...`);
      console.log(`[DB] Firebase Firestore connected`);
    });
  } catch (e) {
    console.error("[BOOT] Fatal error:", e);
    process.exit(1);
  }
}

boot();