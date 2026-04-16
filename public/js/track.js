/* global google */

// Track page:
// - Connects to WebSocket (/ws) using auth token
// - Subscribes to one order (customer/admin)
// - Smoothly animates drone marker updates using Google Maps Geometry
// - Falls back to periodic REST refresh if WS unavailable

const SENSOR_BUBBLE_M_RADAR = 50; // Sensor bubble radius in meters for radar display

const state = {
  order: null,
  me: null,

  map: null,
  markers: { base: null, pickup: null, delivery: null, drone: null },
  routeLine: null,
  legLine: null,

  // WS
  ws: null,
  wsConnected: false,
  wsReconnectTimer: null,

  // Poll fallback / UI
  refresh: null,
  auto: false,

  // Smooth animation between updates
  anim: {
    raf: null,
    running: false,
    from: null,
    to: null,
    startMs: 0,
    durationMs: 900
  },

  // Public fleet drones for radar
  publicFleet: [],

  // Continuous route playback (Base→Pickup→Delivery→Base) so the drone moves
  // even if WS updates are sparse or missing.
  playback: {
    raf: null,
    running: false,
    // reference point: progress at t0
    p0: 0,
    t0: 0,
    // route
    route: null, // { segments:[{a,b,distM,cumM}], totalM }
    speedMps: 18
  }
};

function qs(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
function q(sel) { return document.querySelector(sel); }

function getDroneSpeedMps() {
  const v = Number(window.APP_CONFIG?.DRONE_SPEED_MPS);
  return Number.isFinite(v) && v > 0 ? v : 18;
}

function getDefaultBase() {
  const b = window.APP_CONFIG?.DRONE_BASE;
  if (b && Number.isFinite(b.lat) && Number.isFinite(b.lng)) return { lat: b.lat, lng: b.lng };
  return { lat: 59.3688, lng: 10.4416 };
}

function baseFromOrder(order) {
  const ob = order?.base;
  if (ob && Number.isFinite(ob.lat) && Number.isFinite(ob.lng)) return { lat: ob.lat, lng: ob.lng };
  return getDefaultBase();
}

function setWsBadge(text, kind = "") {
  const el = q("#wsBadge");
  if (!el) return;
  el.textContent = text;
  el.className = "badge";
  if (kind === "ok") el.classList.add("ok");
  if (kind === "error") el.classList.add("danger");
  if (kind === "warn") el.classList.add("warn");
}

/**
 * Show Auto-refresh button only when WS is NOT connected.
 * If WS connects, we hide the button and stop polling to avoid double updates.
 */
function updateAutoRefreshVisibility() {
  const autoBtn = q("#autoRefreshBtn");
  if (!autoBtn) return;

  if (state.wsConnected) {
    // Stop polling if it was enabled
    if (state.refresh) { clearInterval(state.refresh); state.refresh = null; }
    state.auto = false;

    autoBtn.textContent = "Auto-refresh: off";
    autoBtn.style.display = "none";
  } else {
    autoBtn.style.display = "";
  }
}

function badgeForStatus(status) {
  const el = qs("#statusBadge");
  el.className = "badge";
  if (!status) { el.textContent = "—"; return; }
  el.textContent = status;
  if (status === "delivered") el.classList.add("ok");
  else if (status === "in_transit" || status === "returning") el.classList.add("warn");
  else if (status === "cancelled") el.classList.add("danger");
}

function renderMission(order) {
  const badge = q("#missionBadge");
  const hint = q("#missionHint");
  if (!badge || !hint) return;

  if (!order) {
    badge.textContent = "—";
    hint.textContent = "Total ETA: — • Battery: — • Progress: —";
    return;
  }

  const st = order.status || "—";
  badge.textContent = (st === "in_transit" || st === "returning") ? "LIVE" : st;

  const eta = (order.etaMinutes ?? "—");
  const batt = Math.round(order.drone?.battery ?? 0);
  const prog = Math.round((order.progress ?? 0) * 100);
  const phase = order.missionPhase ? ` • ${order.missionPhase}` : "";
  const alt = order.telemetry?.altitude != null ? ` • Alt: ${Math.round(order.telemetry.altitude)}m` : "";
  hint.textContent = `Total ETA: ${eta} min (inc load) • Battery: ${batt}% • Progress: ${prog}%${phase}${alt}`;
}

function renderTelemetry(order) {
  const tel = order?.telemetry;
  const setText = (id, val) => { const el = q(id); if (el) el.textContent = val; };

  if (!tel) {
    setText("#telAlt", "—"); setText("#telHeading", "—"); setText("#telSpeed", "—");
    setText("#telVSpeed", "—"); setText("#telGps", "—"); setText("#telSignal", "—");
    setText("#telSensor", "—"); setText("#telBasket", "—");
    return;
  }

  setText("#telAlt", `${Math.round(tel.altitude ?? 0)}m`);
  setText("#telHeading", `${tel.heading ?? 0}°`);
  setText("#telSpeed", `${tel.groundSpeed ?? 0} km/h`);
  setText("#telVSpeed", `${(tel.verticalSpeed ?? 0) > 0 ? "+" : ""}${(tel.verticalSpeed ?? 0).toFixed(1)} m/s`);
  setText("#telGps", `±${(tel.gpsAccuracy ?? 0).toFixed(1)}m`);

  const sig = tel.signalStrength ?? 0;
  const sigEl = q("#telSignal");
  if (sigEl) {
    sigEl.textContent = `${sig}%`;
    sigEl.style.color = sig > 70 ? "#22c55e" : sig > 30 ? "#eab308" : "#ef4444";
  }

  const bubble = tel.sensorBubble;
  setText("#telSensor", bubble ? `${bubble.active ? "Active" : "Off"} (${bubble.radiusM}m)${bubble.obstacleDetected ? " ⚠️ OBSTACLE" : ""}` : "—");

  const basketLabels = { closed: "🔒 Closed", opening: "🔓 Opening...", open_front: "📂 Open (front)", opening_bottom: "🔓 Opening bottom...", open_bottom: "📦 Open (bottom) - Releasing", closing: "🔒 Closing..." };
  setText("#telBasket", basketLabels[tel.basketState] || tel.basketState || "—");
}

function renderWeather(order) {
  const wx = order?.weather;
  const setText = (id, val) => { const el = q(id); if (el) el.textContent = val; };

  if (!wx) {
    setText("#wxCondition", "—"); setText("#wxTemp", "—");
    setText("#wxWind", "—"); setText("#wxHumidity", "—");
    setText("#wxSource", "—");
    return;
  }

  const condIcons = { clear: "☀️", clouds: "☁️", rain: "🌧️", snow: "❄️", mist: "🌫️", drizzle: "🌦️", thunderstorm: "⛈️" };
  const icon = condIcons[wx.condition] || "🌤️";
  setText("#wxCondition", `${icon} ${wx.description || wx.condition}`);
  setText("#wxTemp", `${wx.temperature}°C`);
  setText("#wxWind", `${wx.windSpeedKmh} km/h (${wx.windDirection}°)`);
  setText("#wxHumidity", `${wx.humidity}%`);
  setText("#wxSource", `Source: ${wx.source || "unknown"} • ${wx.fetchedAt ? new Date(wx.fetchedAt).toLocaleTimeString("en-GB") : ""}`);
}

function renderRemoteId(order) {
  const rid = order?.drone?.remoteId;
  const setText = (id, val) => { const el = q(id); if (el) el.textContent = val; };

  if (!rid) {
    setText("#ridSerial", "—"); setText("#ridOperator", "—");
    setText("#ridDroneId", "—"); setText("#ridCountry", "—");
    return;
  }

  setText("#ridSerial", rid.serial || "—");
  setText("#ridOperator", rid.operator || "—");
  setText("#ridDroneId", order.drone?.droneId || "—");
  setText("#ridCountry", rid.registration || "—");
}

function renderSafety(order) {
  const badge = q("#safetyBadge");
  const hint = q("#safetyHint");
  if (!badge || !hint) return;

  if (!order) {
    badge.textContent = "NOMINAL"; badge.className = "badge ok";
    hint.textContent = "All systems operational";
    return;
  }

  const tel = order.telemetry || {};
  const batt = order.drone?.battery ?? 100;
  const sig = tel.signalStrength ?? 100;
  const phase = order.missionPhase || "";

  if (phase === "emergency_landing" || phase === "emergency_landed") {
    badge.textContent = "EMERGENCY"; badge.className = "badge danger";
    hint.textContent = "Emergency landing active!";
  } else if (batt <= 15) {
    badge.textContent = "CRITICAL"; badge.className = "badge danger";
    hint.textContent = `Critical battery: ${Math.round(batt)}%`;
  } else if (sig < 20) {
    badge.textContent = "SIGNAL LOST"; badge.className = "badge danger";
    hint.textContent = "Signal lost - drone holding position";
  } else if (batt <= 30 || sig < 50) {
    badge.textContent = "WARNING"; badge.className = "badge warn";
    hint.textContent = `Battery: ${Math.round(batt)}% • Signal: ${sig}%`;
  } else if (tel.sensorBubble?.obstacleDetected) {
    badge.textContent = "AVOIDING"; badge.className = "badge warn";
    hint.textContent = "Obstacle avoidance maneuver active";
  } else {
    badge.textContent = "NOMINAL"; badge.className = "badge ok";
    hint.textContent = "All systems operational";
  }
}

async function fetchEvents(id) {
  const res = await fetch(`/api/orders/${encodeURIComponent(id)}/events`, { headers: { ...authHeaders() } });
  if (!res.ok) return [];
  return res.json();
}

function renderEvents(events) {
  const box = q("#events");
  if (!box) return;

  box.innerHTML = "";
  if (!events.length) {
    box.innerHTML = "<div class='hint'>No events yet.</div>";
    return;
  }

  for (const ev of events.slice().reverse().slice(0, 10)) {
    const el = document.createElement("div");
    el.className = "hint";
    el.innerHTML = `<b>${ev.type}</b> • ${new Date(ev.time).toLocaleTimeString("en-GB")} — ${ev.message}`;
    box.appendChild(el);
  }
}

function haversineKm(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function fitMapToPoints(points) {
  if (!state.map || !window.google?.maps || !points?.length) return;
  const bounds = new google.maps.LatLngBounds();
  points.forEach(p => bounds.extend(p));
  state.map.fitBounds(bounds, 80);
}

function ensureMarker(key, point, title) {
  if (!state.map) return null;
  if (!state.markers[key]) {
    state.markers[key] = new google.maps.Marker({ map: state.map, position: point, title });
  } else {
    state.markers[key].setPosition(point);
  }
  return state.markers[key];
}

function stopAnim() {
  if (state.anim.raf) cancelAnimationFrame(state.anim.raf);
  state.anim.raf = null;
  state.anim.running = false;
}

function animateMarkerTo(marker, toPoint, durationMs = 900) {
  if (!marker) return;

  const hasGeom = !!window.google?.maps?.geometry?.spherical;
  const fromPos = marker.getPosition();
  const fromPoint = fromPos ? { lat: fromPos.lat(), lng: fromPos.lng() } : toPoint;

  const eps = 1e-6;
  if (Math.abs(fromPoint.lat - toPoint.lat) < eps && Math.abs(fromPoint.lng - toPoint.lng) < eps) {
    marker.setPosition(toPoint);
    return;
  }

  stopAnim();
  state.anim.running = true;
  state.anim.from = fromPoint;
  state.anim.to = toPoint;
  state.anim.startMs = performance.now();
  state.anim.durationMs = durationMs;

  const fromLL = hasGeom ? new google.maps.LatLng(fromPoint.lat, fromPoint.lng) : null;
  const toLL = hasGeom ? new google.maps.LatLng(toPoint.lat, toPoint.lng) : null;

  function frame(now) {
    if (!state.anim.running) return;
    const t = Math.min(1, (now - state.anim.startMs) / state.anim.durationMs);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    if (hasGeom) {
      const pos = google.maps.geometry.spherical.interpolate(fromLL, toLL, ease);
      marker.setPosition(pos);
    } else {
      const lat = state.anim.from.lat + (state.anim.to.lat - state.anim.from.lat) * ease;
      const lng = state.anim.from.lng + (state.anim.to.lng - state.anim.from.lng) * ease;
      marker.setPosition({ lat, lng });
    }

    if (t >= 1) {
      state.anim.running = false;
      state.anim.raf = null;
      return;
    }
    state.anim.raf = requestAnimationFrame(frame);
  }

  state.anim.raf = requestAnimationFrame(frame);
}

// ---------- Route playback helpers ----------
function buildRoute(base, pickup, delivery) {
  if (!window.google?.maps) return null;
  const toLL = (p) => new google.maps.LatLng(p.lat, p.lng);
  const pts = [toLL(base), toLL(pickup), toLL(delivery), toLL(base)];
  const spherical = window.google?.maps?.geometry?.spherical;
  if (!spherical) return null;

  const segments = [];
  let cumM = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const distM = spherical.computeDistanceBetween(a, b);
    segments.push({ a, b, distM, cumM });
    cumM += distM;
  }
  return { segments, totalM: cumM };
}

function positionOnRoute(route, progress01) {
  const spherical = window.google.maps.geometry.spherical;
  const p = Math.max(0, Math.min(1, Number(progress01 || 0)));
  const targetM = route.totalM * p;
  let seg = route.segments[route.segments.length - 1];
  for (const s of route.segments) {
    if (targetM <= s.cumM + s.distM) { seg = s; break; }
  }
  const segM = Math.max(0, targetM - seg.cumM);
  const t = seg.distM > 0 ? segM / seg.distM : 1;
  const ll = spherical.interpolate(seg.a, seg.b, t);
  return { lat: ll.lat(), lng: ll.lng() };
}

function stopPlayback() {
  if (state.playback.raf) cancelAnimationFrame(state.playback.raf);
  state.playback.raf = null;
  state.playback.running = false;
  state.playback.route = null;
}

function startOrSyncPlayback(order) {
  if (!state.markers.drone) return;
  if (!window.google?.maps?.geometry?.spherical) return;

  const base = baseFromOrder(order);
  const pickup = order.pickup;
  const delivery = order.delivery;
  if (!pickup || !delivery) return;

  // Only play when a mission is active.
  // DISABLED: With server-side telemetry, the server sends precise positions
  // every tick. The client-side playback was fighting with animateMarkerTo
  // causing flickering. We now rely solely on server pushes + smooth animation.
  stopPlayback();
  return;

  const route = buildRoute(base, pickup, delivery);
  if (!route || !route.totalM) return;

  const speed = getDroneSpeedMps();
  const totalTimeS = route.totalM / Math.max(0.1, speed);

  // Sync reference: use server progress if present, otherwise infer from current marker position.
  const serverP = (typeof order.progress === "number") ? Math.max(0, Math.min(1, order.progress)) : null;
  state.playback.route = route;
  state.playback.speedMps = speed;

  // Update p0/t0 so the playhead continues smoothly.
  const now = performance.now();
  if (serverP !== null) {
    state.playback.p0 = serverP;
    state.playback.t0 = now;
  } else if (!state.playback.running) {
    state.playback.p0 = 0;
    state.playback.t0 = now;
  }

  if (state.playback.running) return;
  state.playback.running = true;

  function frame(ts) {
    if (!state.playback.running || !state.playback.route) return;

    const elapsedS = (ts - state.playback.t0) / 1000;
    const p = Math.min(1, state.playback.p0 + (elapsedS / totalTimeS));
    const pos = positionOnRoute(state.playback.route, p);
    state.markers.drone.setPosition(pos);

    if (p >= 1) {
      // Stop at end; server may later mark delivered.
      state.playback.running = false;
      state.playback.raf = null;
      return;
    }
    state.playback.raf = requestAnimationFrame(frame);
  }

  state.playback.raf = requestAnimationFrame(frame);
}

// ---------- Google Maps loader (Geometry for smooth interpolation) ----------
async function loadGoogleMapsApi() {
  // If already loaded, ensure Geometry is available (SPA/back navigation case).
  if (window.google?.maps) {
    try {
      if (window.google.maps.importLibrary) {
        await window.google.maps.importLibrary("geometry");
      }
    } catch {
      // ignore
    }
    return true;
  }
  const key = String(window.APP_CONFIG?.GOOGLE_MAPS_API_KEY || "").trim();
  if (!key) return false;

  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=geometry`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// ---------- API ----------
async function fetchOrder(id) {
  const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error("Not found");
  return res.json();
}

function updateRouteUI(order) {
  const base = baseFromOrder(order);
  qs("#baseBadge").textContent = `${base.lat.toFixed(5)}, ${base.lng.toFixed(5)}`;

  const kmTotal =
    haversineKm(base, order.pickup) +
    haversineKm(order.pickup, order.delivery) +
    haversineKm(order.delivery, base);
  qs("#routeBadge").textContent = `~${kmTotal.toFixed(1)} km`;
}

async function initMap(order) {
  const mapBox = qs("#mapBox");
  try {
    const ok = await loadGoogleMapsApi();
    if (!ok) return;

    const base = baseFromOrder(order);
    if (!state.map) {
      state.map = new google.maps.Map(mapBox, {
        center: base,
        zoom: 11,
        mapTypeControl: false,
        streetViewControl: false
      });
    }

    ensureMarker("base", base, "Base");
    ensureMarker("pickup", order.pickup, "Pickup");
    ensureMarker("delivery", order.delivery, "Delivery");

    const startPos = order.dronePosition || base;
    ensureMarker("drone", startPos, "Drone");

    if (!state.routeLine) state.routeLine = new google.maps.Polyline({ map: state.map, path: [] });
    if (!state.legLine) state.legLine = new google.maps.Polyline({ map: state.map, path: [] });

    state.routeLine.setPath([base, order.pickup, order.delivery, base]);
    state.legLine.setPath([order.pickup, order.delivery]);

    fitMapToPoints([base, order.pickup, order.delivery]);
  } catch (e) {
    console.error(e);
  }
}

function applyOrderToUI(order) {
  state.order = order;

  qs("#orderTitle").textContent = `Order #${order._id}`;
  qs("#orderMeta").textContent = `${order.customerName} • ${order.phone} • ${new Date(order.createdAt).toLocaleString("en-GB")}`;
  badgeForStatus(order.status);
  renderMission(order);
  renderTelemetry(order);
  renderWeather(order);
  renderRemoteId(order);
  renderSafety(order);
  updateRouteUI(order);

  if (window._loadCountdownInterval) {
    clearInterval(window._loadCountdownInterval);
    window._loadCountdownInterval = null;
  }

  // Customer action: start delivery at pickup
  const customerBtn = q("#customerStartBtn");
  const customerCancelBtn = q("#customerCancelBtn");
  const timeoutWarn = q("#customerTimeoutWarn");
  
  if (customerBtn && customerCancelBtn) {
    const isCustomer = state.me?.role === "customer";
    const canStart = isCustomer && order.status === "awaiting_load" && order.missionPhase === "awaiting_load";
    customerBtn.style.display = canStart ? "" : "none";
    customerCancelBtn.style.display = canStart ? "" : "none";
  }

  // Countdown timer for ALL users
  let showAdminMessageBtn = false;
  if (timeoutWarn) {
    const isAwaitingLoad = order.status === "awaiting_load" && order.missionPhase === "awaiting_load";
    if (isAwaitingLoad) {
      timeoutWarn.style.display = "";
      
      const loadStartMs = new Date(order.awaitingLoadSince || Date.now()).getTime();
      const limitMs = 10 * 60 * 1000;
      const autoRecallMs = 15 * 60 * 1000;
      
      function updateTimer() {
        const elapsed = Date.now() - loadStartMs;
        
        if (elapsed <= limitMs) {
          showAdminMessageBtn = false;
          timeoutWarn.className = "badge warn";
          const remainMs = Math.max(0, limitMs - elapsed);
          const secTotal = Math.floor(remainMs / 1000);
          const m = Math.floor(secTotal / 60).toString().padStart(2, "0");
          const s = (secTotal % 60).toString().padStart(2, "0");
          timeoutWarn.textContent = `⏳ ${m}:${s} remaining to load the package.`;
        } else if (elapsed <= autoRecallMs) {
          showAdminMessageBtn = true;
          timeoutWarn.className = "badge danger";
          const remainMs = Math.max(0, autoRecallMs - elapsed);
          const secTotal = Math.floor(remainMs / 1000);
          const m = Math.floor(secTotal / 60).toString().padStart(2, "0");
          const s = (secTotal % 60).toString().padStart(2, "0");
          timeoutWarn.innerHTML = `⚠️ Time limit exceeded! Drone auto-returns in <b>${m}:${s}</b>`;
        } else {
          showAdminMessageBtn = true;
          timeoutWarn.className = "badge danger";
          timeoutWarn.textContent = "🛑 Auto-returning to base. You will be charged the full estimate.";
          if (window._loadCountdownInterval) clearInterval(window._loadCountdownInterval);
        }
        
        // Show/hide admin message button if it exists
        const adminMsgBtn = q("#adminMessageBtn");
        if (adminMsgBtn && state.me?.role === "admin") {
          adminMsgBtn.style.display = showAdminMessageBtn ? "" : "none";
        }
      }
      
      updateTimer();
      window._loadCountdownInterval = setInterval(updateTimer, 1000);
    } else {
      timeoutWarn.style.display = "none";
    }
  }

  // Admin action: recall drone if customer never loads package
  const recallBtn = q("#recallBtn");
  if (recallBtn) {
    const isAdmin = state.me?.role === "admin";
    const canRecall = isAdmin && order.status === "awaiting_load" && order.missionPhase === "awaiting_load";
    recallBtn.style.display = canRecall ? "" : "none";
  }

  if (state.map) {
    const base = baseFromOrder(order);
    ensureMarker("base", base, "Base");
    ensureMarker("pickup", order.pickup, "Pickup");
    ensureMarker("delivery", order.delivery, "Delivery");
    state.routeLine?.setPath([base, order.pickup, order.delivery, base]);
    state.legLine?.setPath([order.pickup, order.delivery]);
  }
  if (state.markers.drone) {
    const pos = order.dronePosition || baseFromOrder(order);
    // With server-side telemetry, we rely on animateMarkerTo for smooth transitions
    // between server-sent positions. No client-side playback needed.
    animateMarkerTo(state.markers.drone, pos, 1000);
  }
}

// ---------- WebSocket ----------
function wsUrl() {
  const token = getAuthToken();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

function wsSend(obj) {
  if (!state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify(obj));
}

function wsConnect() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }

  const token = getAuthToken();
  if (!token) {
    setWsBadge("WS: no token", "warn");
    return;
  }

  try {
    state.ws = new WebSocket(wsUrl());
  } catch (e) {
    setWsBadge("WS: failed", "error");
    return;
  }

  setWsBadge("WS: connecting…", "warn");

  state.ws.addEventListener("open", () => {
    state.wsConnected = true;
    setWsBadge("WS: connected", "ok");
    updateAutoRefreshVisibility();

    if (state.order?._id) {
      wsSend({ type: "subscribe", orderId: state.order._id });
    }
  });

  state.ws.addEventListener("close", () => {
    state.wsConnected = false;
    setWsBadge("WS: disconnected", "warn");
    updateAutoRefreshVisibility();

    if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => wsConnect(), 1500);
  });

  state.ws.addEventListener("error", () => {
    state.wsConnected = false;
    setWsBadge("WS: error", "error");
    updateAutoRefreshVisibility();
  });

  state.ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "error") {
      setWsBadge(`WS: ${msg.message || "error"}`, "error");
      return;
    }

    if (msg.type === "order_update") {
      // Only apply if we are tracking this order
      if (!state.order || msg.order?._id !== state.order._id) return;
      applyOrderToUI(msg.order);
    }
    
    if (msg.type === "public_fleet" && msg.drones) {
      state.publicFleet = msg.drones;
    }
  });
}

// ---------- Load + render ----------
async function loadAndRender(id) {
  const hint = qs("#statusHint");
  hint.textContent = "Loading…";

  try {
    const order = await fetchOrder(id);
    applyOrderToUI(order);

    const events = await fetchEvents(order._id);
    renderEvents(events);

    hint.textContent = "Base → Pickup → Delivery → Base";
    await initMap(order);

    // Start continuous playback once the drone marker exists.
    startOrSyncPlayback(order);

    // If WS is connected, subscribe
    if (state.wsConnected) wsSend({ type: "subscribe", orderId: order._id });
  } catch (e) {
    console.error(e);
    hint.textContent = "Order not found. Check the ID.";
    qs("#orderTitle").textContent = "No order loaded";
    qs("#orderMeta").textContent = "—";
    badgeForStatus(null);
    renderMission(null);
    renderEvents([]);
  }
}

// ---------- Canvas radar (functional) ----------
function startRadar() {
  const canvas = document.querySelector("#radar");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const tooltip = document.querySelector("#radarTooltip");

  let dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  let hoveredDrone = null;

  function resize() {
    const cssW = canvas.clientWidth || 520;
    const cssH = canvas.clientHeight || 320;
    dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  resize();
  window.addEventListener("resize", resize);

  // Convert lat/lng to radar pixel coords (base = center)
  function toRadarXY(point, base, cx, cy, maxR, maxKm) {
    if (!point || !base) return null;
    const km = haversineKm(base, point);
    if (km < 0.001) return { x: cx, y: cy, km: 0 };
    const scale = Math.min(1, km / maxKm) * maxR;
    // Bearing
    const dLng = (point.lng - base.lng) * Math.PI / 180;
    const lat1 = base.lat * Math.PI / 180;
    const lat2 = point.lat * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const bearing = Math.atan2(y, x);
    return {
      x: cx + Math.sin(bearing) * scale,
      y: cy - Math.cos(bearing) * scale,
      km
    };
  }

  function drawDot(ctx, x, y, r, color, label, glow) {
    if (glow) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (glow) ctx.restore();

    if (label) {
      ctx.fillStyle = "rgba(232,238,252,0.85)";
      ctx.font = "600 11px ui-sans-serif, system-ui";
      ctx.fillText(label, x + r + 4, y + 4);
    }
  }

  // Hover detection
  const dots = []; // {x, y, r, info}

  canvas.addEventListener("mousemove", (e) => {
    if (!tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const d of dots) {
      const dx = mx - d.x, dy = my - d.y;
      if (dx * dx + dy * dy < (d.r + 6) * (d.r + 6)) {
        found = d;
        break;
      }
    }

    if (found && found.info) {
      tooltip.innerHTML = found.info;
      tooltip.style.display = "block";
      tooltip.style.left = Math.min(mx + 12, canvas.clientWidth - 160) + "px";
      tooltip.style.top = (my - 10) + "px";
      hoveredDrone = found;
    } else {
      tooltip.style.display = "none";
      hoveredDrone = null;
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (tooltip) tooltip.style.display = "none";
    hoveredDrone = null;
  });

  let t = 0;

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = w / dpr;
    const ch = h / dpr;
    ctx.clearRect(0, 0, cw, ch);

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, cw, ch);

    const cx = cw * 0.5, cy = ch * 0.52;
    const maxR = Math.min(cw, ch) * 0.42;

    // Determine max km for scale
    const order = state.order;
    const base = order ? baseFromOrder(order) : null;
    let maxKm = 10; // default
    if (base && order?.pickup) {
      const d1 = haversineKm(base, order.pickup);
      const d2 = order.delivery ? haversineKm(base, order.delivery) : 0;
      const dronePos = order.dronePosition;
      const d3 = dronePos ? haversineKm(base, dronePos) : 0;
      maxKm = Math.max(2, d1, d2, d3) * 1.3; // 30% padding
    }

    // Distance rings
    const ringCount = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(232,238,252,0.35)";
    ctx.font = "500 10px ui-sans-serif, system-ui";
    for (let i = 1; i <= ringCount; i++) {
      const ringR = (maxR * i) / ringCount;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Cross-hairs
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath(); ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR); ctx.stroke();

    // Sweep arm
    const angle = (t * 0.025) % (Math.PI * 2);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    grad.addColorStop(0, "rgba(82,255,168,0.22)");
    grad.addColorStop(1, "rgba(82,255,168,0.00)");
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, maxR, -0.2, 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Reset dots for hover
    dots.length = 0;

    // ===== No-Fly Zones =====
    if (base) {
      const nfzColors = { restricted: "rgba(239,68,68,0.15)", warning: "rgba(234,179,8,0.15)" };
      const nfzBorder = { restricted: "rgba(239,68,68,0.4)", warning: "rgba(234,179,8,0.35)" };
      for (const z of (window.__nfzCache || [])) {
        if (z.type === "circle") {
          const zp = toRadarXY(z.center, base, cx, cy, maxR, maxKm);
          if (zp) {
            const rPx = (z.radiusKm / maxKm) * maxR;
            ctx.fillStyle = nfzColors[z.severity] || "rgba(239,68,68,0.12)";
            ctx.strokeStyle = nfzBorder[z.severity] || "rgba(239,68,68,0.3)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(zp.x, zp.y, Math.max(4, rPx), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // Label
            ctx.fillStyle = "rgba(239,68,68,0.7)";
            ctx.font = "500 9px ui-sans-serif, system-ui";
            ctx.fillText("NFZ", zp.x - 8, zp.y + 3);
          }
        }
      }
    }

    // Base dot (always center)
    drawDot(ctx, cx, cy, 5, "#7aa2ff", "BASE", false);

    if (base && order) {
      // Pickup
      if (order.pickup) {
        const p = toRadarXY(order.pickup, base, cx, cy, maxR, maxKm);
        if (p) drawDot(ctx, p.x, p.y, 6, "#eab308", "PICKUP", false);
      }

      // Delivery
      if (order.delivery) {
        const d = toRadarXY(order.delivery, base, cx, cy, maxR, maxKm);
        if (d) drawDot(ctx, d.x, d.y, 6, "#22c55e", "DELIVERY", false);
      }

      // Route line (base → pickup → delivery → base)
      if (order.pickup && order.delivery) {
        const pp = toRadarXY(order.pickup, base, cx, cy, maxR, maxKm);
        const dp = toRadarXY(order.delivery, base, cx, cy, maxR, maxKm);
        if (pp && dp) {
          ctx.strokeStyle = "rgba(255,255,255,0.12)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(pp.x, pp.y);
          ctx.lineTo(dp.x, dp.y);
          ctx.lineTo(cx, cy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Drone
      const dronePos = order.dronePosition;
      if (dronePos) {
        const dp = toRadarXY(dronePos, base, cx, cy, maxR, maxKm);
        if (dp) {
          const tel = order.telemetry || {};
          const batt = Math.round(order.drone?.battery ?? 0);
          const droneColor = batt > 60 ? "#52ffa8" : batt > 25 ? "#eab308" : "#ef4444";
          const pulse = 6 + Math.sin(t * 0.08) * 2;

          // ===== SENSOR BUBBLE (pulsing ring around drone) =====
          if (tel.sensorBubble?.active) {
            const bubbleR = Math.max(12, (SENSOR_BUBBLE_M_RADAR / 1000 / maxKm) * maxR);
            const bubblePulse = bubbleR + Math.sin(t * 0.06) * 3;
            ctx.save();
            ctx.strokeStyle = tel.sensorBubble.obstacleDetected ? "rgba(239,68,68,0.6)" : "rgba(82,255,168,0.25)";
            ctx.lineWidth = tel.sensorBubble.obstacleDetected ? 2 : 1;
            ctx.setLineDash(tel.sensorBubble.obstacleDetected ? [] : [3, 3]);
            ctx.beginPath();
            ctx.arc(dp.x, dp.y, bubblePulse, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            if (tel.sensorBubble.obstacleDetected) {
              ctx.fillStyle = "rgba(239,68,68,0.1)";
              ctx.fill();
            }
            ctx.restore();
          }

          drawDot(ctx, dp.x, dp.y, pulse, droneColor, "", true);

          // ===== HEADING ARROW =====
          const heading = tel.heading || 0;
          if (tel.groundSpeed > 0) {
            const arrowLen = 18;
            const hRad = (heading * Math.PI) / 180;
            const ax = dp.x + Math.sin(hRad) * arrowLen;
            const ay = dp.y - Math.cos(hRad) * arrowLen;
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.7)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(dp.x, dp.y);
            ctx.lineTo(ax, ay);
            ctx.stroke();
            // Arrowhead
            const aSize = 5;
            ctx.fillStyle = "rgba(255,255,255,0.7)";
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax - Math.sin(hRad - 0.5) * aSize, ay + Math.cos(hRad - 0.5) * aSize);
            ctx.lineTo(ax - Math.sin(hRad + 0.5) * aSize, ay + Math.cos(hRad + 0.5) * aSize);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }

          // Drone emoji + altitude
          ctx.fillStyle = "rgba(232,238,252,0.9)";
          ctx.font = "700 11px ui-sans-serif, system-ui";
          ctx.fillText("🚁", dp.x - 8, dp.y - pulse - 4);

          // Altitude label
          const altM = Math.round(tel.altitude ?? dronePos.alt ?? 0);
          ctx.fillStyle = "rgba(82,255,168,0.8)";
          ctx.font = "600 10px ui-sans-serif, system-ui";
          ctx.fillText(`${altM}m`, dp.x + pulse + 4, dp.y - 2);

          // Signal indicator
          const sig = tel.signalStrength ?? 100;
          if (sig < 50) {
            ctx.fillStyle = sig < 20 ? "rgba(239,68,68,0.9)" : "rgba(234,179,8,0.8)";
            ctx.font = "600 9px ui-sans-serif, system-ui";
            ctx.fillText(sig < 20 ? "📡✕" : "📡!", dp.x + pulse + 4, dp.y + 10);
          }

          // Basket state indicator
          const basketState = tel.basketState || "closed";
          if (basketState !== "closed") {
            ctx.fillStyle = "rgba(234,179,8,0.9)";
            ctx.font = "600 9px ui-sans-serif, system-ui";
            const basketIcon = basketState.includes("open") ? "📂" : "🔓";
            ctx.fillText(basketIcon, dp.x - pulse - 16, dp.y + 4);
          }

          // Enhanced tooltip with telemetry data
          const rid = order.drone?.remoteId;
          dots.push({
            x: dp.x, y: dp.y, r: pulse + 4,
            info: `<b>${escapeHtml(order.drone?.droneId || "Drone")}</b>${rid ? ` <small>(${escapeHtml(rid.serial)})</small>` : ""}<br>` +
              `Status: ${escapeHtml(order.status || "—")} • Phase: ${escapeHtml(order.missionPhase || "—")}<br>` +
              `Battery: ${batt}% • Speed: ${tel.groundSpeed ?? "—"} km/h<br>` +
              `Altitude: ${altM}m • Heading: ${heading}°<br>` +
              `Signal: ${sig}% • GPS: ±${(tel.gpsAccuracy ?? 0).toFixed(1)}m<br>` +
              `Sensor: ${tel.sensorBubble?.active ? "Active" : "Off"}${tel.sensorBubble?.obstacleDetected ? " ⚠️ OBSTACLE" : ""}<br>` +
              `Basket: ${basketState}<br>` +
              `Distance: ${dp.km.toFixed(1)} km from base`
          });
        }
      }

      // ===== NEARBY DRONES (PUBLIC FLEET) (ADMIN ONLY) =====
      if (state.me?.role === "admin" && state.publicFleet && state.publicFleet.length > 0) {
        for (const pDrone of state.publicFleet) {
          // Skip the main drone for this order
          if (order.drone?.droneId && pDrone.droneId === order.drone.droneId) continue;
          
          if (pDrone.position) {
            const dp = toRadarXY(pDrone.position, base, cx, cy, maxR, maxKm);
            if (dp && dp.km <= maxKm) {
              // Draw a smaller, subtle dot
              drawDot(ctx, dp.x, dp.y, 4, "rgba(122, 162, 255, 0.8)", "", false);
              dots.push({
                x: dp.x, y: dp.y, r: 6,
                info: `<b>Nearby Drone (${pDrone.droneId})</b><br/>Distance: ${dp.km.toFixed(2)} km`
              });
            }
          }
        }
      }
    }

    // Title overlay
    ctx.fillStyle = "rgba(232,238,252,0.85)";
    ctx.font = "600 13px ui-sans-serif, system-ui";
    ctx.fillText("DRONE RADAR", 12, 20);

    // Legend
    ctx.font = "500 10px ui-sans-serif, system-ui";
    ctx.fillStyle = "#7aa2ff"; ctx.fillRect(12, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Base", 24, 38);
    ctx.fillStyle = "#eab308"; ctx.fillRect(60, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Pickup", 72, 38);
    ctx.fillStyle = "#22c55e"; ctx.fillRect(120, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Delivery", 132, 38);
    ctx.fillStyle = "#52ffa8"; ctx.fillRect(190, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Drone", 202, 38);
    ctx.fillStyle = "rgba(239,68,68,0.5)"; ctx.fillRect(240, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("NFZ", 252, 38);
    ctx.fillStyle = "rgba(82,255,168,0.3)"; ctx.fillRect(280, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Sensor", 292, 38);

    t++;
    requestAnimationFrame(draw);
  }
  draw();
}

// ---------- Main ----------
(async function main() {
  ensureAuthOrRedirect();
  startRadar();

  // Load no-fly zones for radar display
  try {
    const nfzRes = await fetch("/api/geofence/zones");
    if (nfzRes.ok) window.__nfzCache = await nfzRes.json();
  } catch { window.__nfzCache = []; }

  state.me = await fetchMe().catch(() => null);

  // Initial visibility before WS connects (assume disconnected until open event)
  updateAutoRefreshVisibility();

  const customerStartBtn = q("#customerStartBtn");
  if (customerStartBtn) {
    customerStartBtn.addEventListener("click", async () => {
      if (!state.order?._id) return;
      customerStartBtn.disabled = true;
      customerStartBtn.textContent = "Starting…";
      try {
        const r = await fetch(`/api/orders/${encodeURIComponent(state.order._id)}/customer_start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() }
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(data.error || "Could not start delivery");
        } else {
          applyOrderToUI(data);
          // Re-subscribe in case WS was late
          if (state.wsConnected) wsSend({ type: "subscribe", orderId: data._id });
        }
      } finally {
        customerStartBtn.disabled = false;
        customerStartBtn.textContent = "Package loaded – start delivery";
      }
    });

    const customerCancelBtn = q("#customerCancelBtn");
    if (customerCancelBtn) {
      customerCancelBtn.addEventListener("click", async () => {
        if (!state.order?._id) return;
        const ok = confirm("Are you sure you want to cancel?\n\nYou will be charged the full estimated price as the drone is already at the pickup location.");
        if (!ok) return;

        customerCancelBtn.disabled = true;
        customerCancelBtn.textContent = "Cancelling...";
        try {
          const r = await fetch(`/api/orders/${encodeURIComponent(state.order._id)}/customer_recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() }
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            alert(data.error || "Could not cancel order");
          } else {
            applyOrderToUI(data);
            try {
              const events = await fetchEvents(data._id);
              renderEvents(events);
            } catch (e) {}
          }
        } finally {
          customerCancelBtn.disabled = false;
          customerCancelBtn.textContent = "Cancel Order (Full charge applies)";
        }
      });
    }

    const adminMessageBtn = q("#adminMessageBtn");
    if (adminMessageBtn) {
      adminMessageBtn.addEventListener("click", async () => {
        const o = state.order;
        if (!o?._id) return;
        const text = prompt(`Send message to ${o.customerName || "Customer"} (${o.email || "No email"}):`);
        if (!text) return;
        try {
          const res = await fetch("/api/contacts/admin-init", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({
              customerId: o.customerId,
              name: o.customerName,
              email: o.email,
              message: text
            })
          });
          if (res.ok) alert("Message sent!");
          else {
            const err = await res.json().catch(()=>({}));
            alert("Error: " + (err.error || "failed"));
          }
        } catch (e) {
          alert("Network error");
        }
      });
    }
  }

  const recallBtn = q("#recallBtn");
  if (recallBtn) {
    recallBtn.addEventListener("click", async () => {
      if (!state.order?._id) return;
      const ok = confirm(
        "Recall drone and cancel the mission?\n\nCustomer will be charged the full estimated price for the order."
      );
      if (!ok) return;

      recallBtn.disabled = true;
      const oldText = recallBtn.textContent;
      recallBtn.textContent = "Recalling…";

      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(state.order._id)}/recall`, {
          method: "POST",
          headers: { ...authHeaders() }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || "Could not recall drone.");
          return;
        }
        applyOrderToUI(data);
        // Refresh events panel after recall
        try {
          const events = await fetchEvents(data._id);
          renderEvents(events);
        } catch (e) {
          // Non-fatal; recall succeeded even if events can't be fetched.
        }
      } catch (e) {
        alert("Could not recall drone.");
      } finally {
        recallBtn.disabled = false;
        recallBtn.textContent = oldText;
      }
    });
  }

  // Initial WS connect
  wsConnect();

  const idParam = getParam("id");
  if (idParam) {
    qs("#orderId").value = idParam;
    await loadAndRender(idParam);
  }

  qs("#loadBtn").addEventListener("click", async () => {
    const id = qs("#orderId").value.trim();
    if (!id) return;
    await loadAndRender(id);
  });

  const autoBtn = q("#autoRefreshBtn");
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      state.auto = !state.auto;
      autoBtn.textContent = `Auto-refresh: ${state.auto ? "on" : "off"}`;

      if (state.refresh) { clearInterval(state.refresh); state.refresh = null; }
      if (state.auto && state.order?._id) {
        state.refresh = setInterval(() => loadAndRender(state.order._id), 4000);
      }
    });
  }

  // Lightweight REST fallback refresh (if WS not connected)
  setInterval(async () => {
    if (!state.order?._id) return;
    if (state.wsConnected) return; // WS is primary
    try {
      const fresh = await fetchOrder(state.order._id);
      applyOrderToUI(fresh);
    } catch {}
  }, 3500);

  // Speed note (ensures DRONE_SPEED_MPS is “used” even if WS sends sparse updates)
  // If server sends updates slowly, increase animation duration based on speed.
  // (Duration is scaled so fast drones animate quicker.)
  const speed = getDroneSpeedMps();
  state.anim.durationMs = Math.max(450, Math.min(1400, 1200 * (18 / speed)));
})();