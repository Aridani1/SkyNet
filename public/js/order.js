/* global google */ // @ShazebAyubAlam

const state = {
  services: null,
  map: null,
  markers: { pickup: null, delivery: null, base: null, drone: null },
  line: null,        // pickup->delivery
  routeLine: null,   // base->pickup->delivery->base
  geocoder: null,
  pickMode: "pickup",
  pickupAC: null,
  deliveryAC: null,
  droneAnim: { raf: null, running: false }
};

function getDroneBase() {
  const b = window.APP_CONFIG?.DRONE_BASE;
  if (b && Number.isFinite(b.lat) && Number.isFinite(b.lng)) return { lat: b.lat, lng: b.lng };
  // Default: Hamar (Holsetgata 31)
  return { lat: 59.3688, lng: 10.4416 };
}

function getDroneSpeedMps() {
  const v = Number(window.APP_CONFIG?.DRONE_SPEED_MPS);
  return Number.isFinite(v) && v > 0 ? v : 18;
}

// ---------- Helpers ----------
function qs(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

function q(sel) { return document.querySelector(sel); }

function getParam(key) {
  const u = new URL(location.href);
  return u.searchParams.get(key);
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function readCoords(prefix) {
  const lat = toNumber(qs(`#${prefix}Lat`).value);
  const lng = toNumber(qs(`#${prefix}Lng`).value);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function samePoint(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.lng - b.lng) < 0.00001;
}

// ---------- Geo math (estimate) ----------
function haversineKm(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * (Math.sin(dLng / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
  return R * c;
}

// ---------- No-fly zone check ----------
let _nfzCache = null;
async function loadNfzZones() {
  try {
    const res = await fetch("/api/geofence/zones");
    if (res.ok) _nfzCache = await res.json();
  } catch { _nfzCache = []; }
}

function checkPointInNfz(point, label) {
  if (!_nfzCache || !point) return null;
  for (const z of _nfzCache) {
    if (z.type === "circle") {
      const dist = haversineKm(point, z.center);
      if (dist <= z.radiusKm) {
        return `🚫 ${label} is inside no-fly zone: ${z.name}`;
      }
    }
  }
  return null;
}

// ---------- Google Maps loader (Places + Geometry) ----------
async function loadGoogleMapsApi() {
  // If Maps is already loaded (e.g. by another page/navigation), we may still
  // need to load extra libraries (Places/Geometry). We'll try importLibrary.
  if (window.google?.maps) {
    try {
      if (window.google.maps.importLibrary) {
        // These will no-op if already available.
        await window.google.maps.importLibrary("places");
        await window.google.maps.importLibrary("geometry");
      }
    } catch {
      // ignore; we'll fall back gracefully
    }
    return true;
  }

  const key = String(window.APP_CONFIG?.GOOGLE_MAPS_API_KEY || window.GOOGLE_MAPS_API_KEY || "").trim();
  if (!key) return false;

  return new Promise(resolve => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=places,geometry`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// ---------- Selection + estimate ----------
function currentSelection() {
  const deliveryTypeId = qs("#deliveryType").value;
  const deliveryType = state.services?.deliveryTypes?.find(x => x.id === deliveryTypeId) || null;
  const weightKg = Number(qs("#weight").value || 0);
  const pickupPoint = readCoords("pickup");
  const deliveryPoint = readCoords("delivery");
  const pkgLength = Number(q("#pkgLength")?.value || 0);
  const pkgWidth = Number(q("#pkgWidth")?.value || 0);
  const pkgHeight = Number(q("#pkgHeight")?.value || 0);
  return { deliveryType, weightKg, pickupPoint, deliveryPoint, pkgLength, pkgWidth, pkgHeight };
}

function computeEstimate(pickupPoint, deliveryPoint) {
  if (!state.services) return null;
  const { deliveryType, weightKg } = currentSelection();
  if (!pickupPoint || !deliveryPoint || !deliveryType) return null;

  const base = getDroneBase();
  const totalKm = haversineKm(base, pickupPoint) + haversineKm(pickupPoint, deliveryPoint) + haversineKm(deliveryPoint, base);
  const est = deliveryType.baseNok + deliveryType.perKmNok * totalKm + Math.max(0, weightKg - 1) * 12;
  return { km: totalKm, est: Math.round(est) };
}

function updateEstimateUIFromPoints(pickupPoint, deliveryPoint) {
  const badge = qs("#estimateBadge");
  const r = computeEstimate(pickupPoint, deliveryPoint);
  if (!r) {
    badge.textContent = "Estimate: —";
    return;
  }
  badge.textContent = `Estimate: ${fmtNok(r.est)} • ~${r.km.toFixed(1)} km total trip`;
}

// ---------- UI fill ----------
async function loadServices() {
  const res = await fetch("assets/services.json");
  if (!res.ok) throw new Error("Failed to load services.json");
  state.services = await res.json();
}

function autoSelectDeliveryType() {
  const display = document.querySelector("#autoTypeDisplay");
  const hidden = document.querySelector("#deliveryType");
  if (!display || !hidden || !state.services) return;

  const weightKg = Number(document.querySelector("#weight")?.value || 0);
  const pickupPoint = readCoords("pickup");
  const deliveryPoint = readCoords("delivery");

  if (!pickupPoint || !deliveryPoint) {
    display.textContent = "Set addresses and weight to auto-detect";
    hidden.value = "";
    return;
  }

  // No-fly zone check
  const nfzCheck = checkPointInNfz(pickupPoint, "Pickup") || checkPointInNfz(deliveryPoint, "Delivery");
  if (nfzCheck) {
    display.textContent = nfzCheck;
    display.style.color = "#ef4444";
    hidden.value = "";
    return;
  }

  const base = getDroneBase();
  const kmBaseToPickup = haversineKm(base, pickupPoint);
  const kmPickupToDelivery = haversineKm(pickupPoint, deliveryPoint);
  const kmDeliveryToBase = haversineKm(deliveryPoint, base);
  const totalKm = kmBaseToPickup + kmPickupToDelivery + kmDeliveryToBase;

  const types = state.services.deliveryTypes || [];
  const light = types.find(t => t.id === "light");
  const heavy = types.find(t => t.id === "heavy");
  const longrange = types.find(t => t.id === "longrange");

  // Max ranges (approximate from 90% usable battery / drain)
  const lightMaxKm = 56;
  const heavyMaxKm = 50;
  const longrangeMaxKm = 90;

  let selected = null;

  // Read package dimensions
  const pl = Number(q("#pkgLength")?.value || 0);
  const pw = Number(q("#pkgWidth")?.value || 0);
  const ph = Number(q("#pkgHeight")?.value || 0);
  const hasDims = pl > 0 && pw > 0 && ph > 0;

  // Check if package is too large for ALL baskets
  if (hasDims) {
    const fitsAny = Object.keys(BASKET_DIMS).some(t => pkgFits(pl, pw, ph, t));
    if (!fitsAny) {
      display.textContent = `⚠️ Package ${pl}×${pw}×${ph} cm is too large for any drone basket`;
      display.style.color = "#ef4444";
      hidden.value = "";
      return;
    }
  }

  if (weightKg > 20) {
    display.textContent = "⚠️ Weight exceeds 20 kg – too heavy for drone delivery";
    display.style.color = "#ef4444";
    hidden.value = "";
    return;
  }

  if (totalKm > longrangeMaxKm) {
    display.textContent = `⚠️ Total trip ${totalKm.toFixed(1)} km exceeds maximum range (${longrangeMaxKm} km)`;
    display.style.color = "#ef4444";
    hidden.value = "";
    return;
  }

  if (totalKm > heavyMaxKm) {
    // Must use longrange
    selected = longrange;
  } else if (weightKg > 5) {
    // Heavy package by weight
    selected = heavy;
  } else {
    // Light package, fits within light range
    if (totalKm <= lightMaxKm) {
      selected = light;
    } else {
      selected = longrange;
    }
  }

  // Dimension check: if package doesn't fit the selected drone, upgrade
  if (selected && hasDims && !pkgFits(pl, pw, ph, selected.id)) {
    // Try upgrading: light → heavy → longrange
    const upgradePath = ["heavy", "longrange"];
    let upgraded = null;
    for (const tryType of upgradePath) {
      if (pkgFits(pl, pw, ph, tryType)) {
        const tryDrone = types.find(t => t.id === tryType);
        if (tryDrone) {
          // Also check range
          const maxKmForType = tryType === "heavy" ? heavyMaxKm : longrangeMaxKm;
          if (totalKm <= maxKmForType) {
            upgraded = tryDrone;
            break;
          }
        }
      }
    }
    if (upgraded) {
      selected = upgraded;
    } else {
      display.textContent = `⚠️ Package ${pl}×${pw}×${ph} cm doesn't fit any available drone for this route`;
      display.style.color = "#ef4444";
      hidden.value = "";
      return;
    }
  }

  if (selected) {
    hidden.value = selected.id;
    display.style.color = "#22c55e";
    const price = selected.baseNok + selected.perKmNok * totalKm + Math.max(0, weightKg - 1) * 12;
    display.textContent = `✅ ${selected.label} • Total trip: ~${totalKm.toFixed(1)} km • ${fmtNok(Math.round(price))}`;
  } else {
    hidden.value = types[0]?.id || "";
    display.textContent = "Auto-detecting…";
    display.style.color = "";
  }

  // Check basket fit
  checkBasketFit();
}

// Basket dimensions (must match server BASKET_DIMENSIONS)
const BASKET_DIMS = {
  light:     { l: 30, w: 25, h: 20, label: "Light (30×25×20 cm)" },
  heavy:     { l: 45, w: 35, h: 30, label: "Heavy (45×35×30 cm)" },
  longrange: { l: 40, w: 30, h: 25, label: "Long-range (40×30×25 cm)" },
};

function pkgFits(pl, pw, ph, type) {
  const b = BASKET_DIMS[type];
  if (!b) return false;
  const perms = [
    [pl, pw, ph], [pl, ph, pw], [pw, pl, ph],
    [pw, ph, pl], [ph, pl, pw], [ph, pw, pl],
  ];
  return perms.some(([l, w, h]) => l <= b.l && w <= b.w && h <= b.h);
}

function checkBasketFit() {
  const display = document.querySelector("#basketFitDisplay");
  if (!display) return;
  const pl = Number(q("#pkgLength")?.value || 0);
  const pw = Number(q("#pkgWidth")?.value || 0);
  const ph = Number(q("#pkgHeight")?.value || 0);
  const droneType = qs("#deliveryType").value;

  if (pl <= 0 || pw <= 0 || ph <= 0) {
    display.textContent = "Enter package dimensions";
    display.style.color = "";
    return;
  }

  if (!droneType) {
    const fits = Object.keys(BASKET_DIMS).filter(t => pkgFits(pl, pw, ph, t));
    if (fits.length === 0) {
      display.textContent = `❌ ${pl}×${pw}×${ph} cm – too large for all baskets`;
      display.style.color = "#ef4444";
    } else {
      display.textContent = `📦 ${pl}×${pw}×${ph} cm fits: ${fits.map(t => BASKET_DIMS[t].label).join(", ")}`;
      display.style.color = "#22c55e";
    }
    return;
  }

  if (pkgFits(pl, pw, ph, droneType)) {
    display.textContent = `✅ ${pl}×${pw}×${ph} cm fits in ${BASKET_DIMS[droneType]?.label || droneType}`;
    display.style.color = "#22c55e";
  } else {
    const fits = Object.keys(BASKET_DIMS).filter(t => pkgFits(pl, pw, ph, t));
    if (fits.length === 0) {
      display.textContent = `❌ ${pl}×${pw}×${ph} cm – too large for any drone basket`;
    } else {
      display.textContent = `⚠️ Too big for ${droneType}. Fits: ${fits.map(t => BASKET_DIMS[t].label).join(", ")}`;
    }
    display.style.color = "#ef4444";
  }
}

// ---------- Map + address ----------
function setPickMode(mode) {
  state.pickMode = mode === "delivery" ? "delivery" : "pickup";
  const badge = document.querySelector("#pickModeBadge");
  if (badge) badge.textContent = state.pickMode === "pickup" ? "Picking: pickup" : "Picking: delivery";
}

function setCoordInputs(prefix, point) {
  qs(`#${prefix}Lat`).value = Number(point.lat).toFixed(6);
  qs(`#${prefix}Lng`).value = Number(point.lng).toFixed(6);
}

function setGmapsLink(prefix, point) {
  const a = document.querySelector(`#${prefix}Gmaps`);
  if (!a) return;
  a.href = `https://www.google.com/maps?q=${encodeURIComponent(point.lat + "," + point.lng)}`;
}

// ---------- Nominatim (OpenStreetMap) geocoding – no API key needed ----------
async function nominatimSearch(query, limit = 5) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=${limit}&addressdetails=1&countrycodes=no`;
  const res = await fetch(url, { headers: { "Accept-Language": "no,en" } });
  if (!res.ok) return [];
  return await res.json();
}

async function nominatimReverse(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "no,en" } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.display_name || null;
}

async function reverseGeocode(point) {
  // Try Google first if available, then Nominatim
  if (state.geocoder) {
    return new Promise(resolve => {
      state.geocoder.geocode({ location: point }, (results, status) => {
        if (status === "OK" && results && results.length) {
          resolve(results[0].formatted_address || null);
        } else {
          // Fallback to Nominatim
          nominatimReverse(point.lat, point.lng).then(resolve).catch(() => resolve(null));
        }
      });
    });
  }
  return nominatimReverse(point.lat, point.lng);
}

async function updateAddress(prefix, point) {
  const el = document.querySelector(`#${prefix}Addr`);
  if (!el) return;
  el.textContent = "Finding address…";
  const addr = await reverseGeocode(point);
  el.textContent = addr || "—";
  // Also update the search input so it reflects the map click
  const searchInput = document.querySelector(`#${prefix}Search`);
  if (searchInput && addr) searchInput.value = addr;
}

const _addrTimers = { pickup: null, delivery: null };
function scheduleAddressUpdate(prefix, point, delayMs = 350) {
  clearTimeout(_addrTimers[prefix]);
  _addrTimers[prefix] = setTimeout(() => {
    updateAddress(prefix, point).catch(() => {});
  }, delayMs);
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

function updateRouteLine() {
  if (!state.routeLine) return;
  const base = getDroneBase();
  const pickup = readCoords("pickup");
  const delivery = readCoords("delivery");
  const path = [base];
  if (pickup) path.push(pickup);
  if (delivery) path.push(delivery);
  path.push(base);
  state.routeLine.setPath(path);
}

async function applyPoint(prefix, point, { pan = true } = {}) {
  setCoordInputs(prefix, point);
  setGmapsLink(prefix, point);

  ensureMarker(prefix, point, prefix);

  scheduleAddressUpdate(prefix, point);

  const pickup = prefix === "pickup" ? point : readCoords("pickup");
  const delivery = prefix === "delivery" ? point : readCoords("delivery");

  if (pickup && delivery && state.line) {
    state.line.setPath([pickup, delivery]);
    updateEstimateUIFromPoints(pickup, delivery);
  }

  updateRouteLine();

  if (pan && state.map) state.map.panTo(point);

  autoSelectDeliveryType();
  await refreshEstimateAndMap();
}

// ---------- Autocomplete dropdown ----------
function createDropdown(inputEl) {
  let dropdown = inputEl.parentElement.querySelector(".addr-dropdown");
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.className = "addr-dropdown";
    dropdown.style.cssText = "position:absolute;z-index:999;background:var(--card,#1e293b);border:1px solid rgba(255,255,255,0.15);border-radius:8px;max-height:220px;overflow-y:auto;width:100%;box-shadow:0 8px 24px rgba(0,0,0,0.4);display:none;";
    inputEl.parentElement.style.position = "relative";
    inputEl.parentElement.appendChild(dropdown);
  }
  return dropdown;
}

function showDropdown(dropdown, results, onSelect) {
  dropdown.innerHTML = "";
  if (!results.length) {
    dropdown.style.display = "none";
    return;
  }
  for (const r of results) {
    const item = document.createElement("div");
    item.style.cssText = "padding:10px 12px;cursor:pointer;font-size:0.9em;border-bottom:1px solid rgba(255,255,255,0.06);transition:background 0.15s;";
    item.textContent = r.display_name;
    item.onmouseenter = () => item.style.background = "rgba(255,255,255,0.08)";
    item.onmouseleave = () => item.style.background = "transparent";
    item.onclick = () => {
      onSelect(r);
      dropdown.style.display = "none";
    };
    dropdown.appendChild(item);
  }
  dropdown.style.display = "block";
}

function initAddressSearch() {
  const pickupInput = qs("#pickupSearch");
  const deliveryInput = qs("#deliverySearch");

  function wireAutocomplete(prefix, inputEl) {
    const dropdown = createDropdown(inputEl);
    let timer = null;

    inputEl.addEventListener("input", () => {
      clearTimeout(timer);
      const q = inputEl.value.trim();
      if (q.length < 3) { dropdown.style.display = "none"; return; }
      timer = setTimeout(async () => {
        try {
          const results = await nominatimSearch(q);
          showDropdown(dropdown, results, async (r) => {
            const point = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
            inputEl.value = r.display_name;
            const addrEl = document.querySelector(`#${prefix}Addr`);
            if (addrEl) addrEl.textContent = r.display_name;
            await applyPoint(prefix, point, { pan: true });
          });
        } catch {}
      }, 300);
    });

    // Enter key: force search
    inputEl.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const q = inputEl.value.trim();
        if (!q) return;
        try {
          const results = await nominatimSearch(q, 1);
          if (results.length) {
            const r = results[0];
            const point = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
            inputEl.value = r.display_name;
            const addrEl = document.querySelector(`#${prefix}Addr`);
            if (addrEl) addrEl.textContent = r.display_name;
            await applyPoint(prefix, point, { pan: true });
          }
        } catch {}
        dropdown.style.display = "none";
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (!inputEl.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = "none";
      }
    });
  }

  wireAutocomplete("pickup", pickupInput);
  wireAutocomplete("delivery", deliveryInput);

  // Also try Google Places Autocomplete if available (bonus)
  if (window.google?.maps?.places?.Autocomplete) {
    const opts = {
      fields: ["geometry", "formatted_address", "name"],
      componentRestrictions: { country: ["no"] }
    };

    state.pickupAC = new google.maps.places.Autocomplete(pickupInput, opts);
    state.deliveryAC = new google.maps.places.Autocomplete(deliveryInput, opts);

    state.pickupAC.addListener("place_changed", async () => {
      const place = state.pickupAC.getPlace();
      const loc = place?.geometry?.location;
      if (!loc) return;
      const point = { lat: loc.lat(), lng: loc.lng() };
      const addrEl = document.querySelector("#pickupAddr");
      if (addrEl) addrEl.textContent = place.formatted_address || place.name || "—";
      await applyPoint("pickup", point, { pan: true });
    });

    state.deliveryAC.addListener("place_changed", async () => {
      const place = state.deliveryAC.getPlace();
      const loc = place?.geometry?.location;
      if (!loc) return;
      const point = { lat: loc.lat(), lng: loc.lng() };
      const addrEl = document.querySelector("#deliveryAddr");
      if (addrEl) addrEl.textContent = place.formatted_address || place.name || "—";
      await applyPoint("delivery", point, { pan: true });
    });
  }
}

// ---------- Drone animation (preview) ----------
function setDroneBadge(text) {
  const el = document.querySelector("#droneBadge");
  if (el) el.textContent = text;
}

function stopDrone() {
  if (state.droneAnim.raf) cancelAnimationFrame(state.droneAnim.raf);
  state.droneAnim.raf = null;
  state.droneAnim.running = false;
  setDroneBadge("Drone: idle");
}

function ensureDroneMarker(startPoint) {
  if (!state.map) return null;
  if (!state.markers.drone) {
    state.markers.drone = new google.maps.Marker({
      map: state.map,
      position: startPoint,
      title: "Drone"
    });
  } else {
    state.markers.drone.setPosition(startPoint);
  }
  return state.markers.drone;
}

function buildRouteLatLngs() {
  const base = getDroneBase();
  const pickup = readCoords("pickup");
  const delivery = readCoords("delivery");
  if (!pickup || !delivery) return null;
  const toLatLng = p => new google.maps.LatLng(p.lat, p.lng);
  return [toLatLng(base), toLatLng(pickup), toLatLng(delivery), toLatLng(base)];
}

function animateDroneAlongRoute(routeLatLngs, { speedMps = 18 } = {}) {
  if (!window.google?.maps?.geometry?.spherical) {
    setDroneBadge("Drone: geometry lib missing");
    return;
  }

  stopDrone();
  state.droneAnim.running = true;
  setDroneBadge("Drone: flying…");

  const segments = [];
  for (let i = 0; i < routeLatLngs.length - 1; i++) {
    const a = routeLatLngs[i];
    const b = routeLatLngs[i + 1];
    const distM = google.maps.geometry.spherical.computeDistanceBetween(a, b);
    segments.push({ a, b, distM });
  }
  const totalM = segments.reduce((s, x) => s + x.distM, 0);
  const start = performance.now();

  ensureDroneMarker(routeLatLngs[0]);

  const pointsPlain = routeLatLngs.map(ll => ({ lat: ll.lat(), lng: ll.lng() }));
  fitMapToPoints(pointsPlain);

  function frame(now) {
    if (!state.droneAnim.running) return;

    const elapsedS = (now - start) / 1000;
    const traveledM = Math.min(totalM, elapsedS * speedMps);

    let acc = 0;
    let segIndex = 0;
    while (segIndex < segments.length && acc + segments[segIndex].distM < traveledM) {
      acc += segments[segIndex].distM;
      segIndex++;
    }

    if (segIndex >= segments.length) {
      const end = routeLatLngs[routeLatLngs.length - 1];
      state.markers.drone.setPosition(end);
      setDroneBadge("Drone: arrived (back at base)");
      state.droneAnim.running = false;
      state.droneAnim.raf = null;
      return;
    }

    const seg = segments[segIndex];
    const segT = seg.distM <= 0 ? 1 : (traveledM - acc) / seg.distM;
    const pos = google.maps.geometry.spherical.interpolate(seg.a, seg.b, segT);
    state.markers.drone.setPosition(pos);

    const pct = totalM > 0 ? Math.round((traveledM / totalM) * 100) : 0;
    setDroneBadge(`Drone: flying… (${pct}%)`);

    state.droneAnim.raf = requestAnimationFrame(frame);
  }

  state.droneAnim.raf = requestAnimationFrame(frame);
}

// ---------- Map init ----------
async function initMapIfPossible({ enableDronePreview = true } = {}) {
  const mapBox = qs("#mapBox");

  // Always init address autocomplete (Nominatim works without Google)
  initAddressSearch();

  try {
    const ok = await loadGoogleMapsApi();
    if (!ok) return;

    state.geocoder = new google.maps.Geocoder();

    const base = getDroneBase();
    const pickup = readCoords("pickup");
    const delivery = readCoords("delivery");

    const defaultCenter = pickup || delivery || base;
    state.map = new google.maps.Map(mapBox, {
      center: defaultCenter,
      zoom: 12,
      mapTypeControl: false,
      streetViewControl: false
    });

    // Base marker
    ensureMarker("base", base, "Drone base");

    // Markers if coords exist
    if (pickup) ensureMarker("pickup", pickup, "Pickup");
    if (delivery) ensureMarker("delivery", delivery, "Delivery");

    state.line = new google.maps.Polyline({ map: state.map, path: [] });
    state.routeLine = new google.maps.Polyline({ map: state.map, path: [] });

    if (pickup && delivery) {
      state.line.setPath([pickup, delivery]);
      updateEstimateUIFromPoints(pickup, delivery);
    }

    updateRouteLine();

    state.map.addListener("click", async e => {
      const point = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      await applyPoint(state.pickMode, point, { pan: false });
    });

    qs("#pickPickupBtn").addEventListener("click", () => setPickMode("pickup"));
    qs("#pickDeliveryBtn").addEventListener("click", () => setPickMode("delivery"));
    setPickMode("pickup");

    // Only wire these buttons if enabled (admin-only preview)
    const simBtn = q("#simulateDroneBtn");
    const stopBtn = q("#stopDroneBtn");

    if (enableDronePreview) {
      if (simBtn) {
        simBtn.addEventListener("click", () => {
          const route = buildRouteLatLngs();
          if (!route) {
            setDroneBadge("Drone: set pickup + delivery first");
            return;
          }
          animateDroneAlongRoute(route, { speedMps: getDroneSpeedMps() });
        });
      }
      if (stopBtn) stopBtn.addEventListener("click", stopDrone);
    } else {
      // Hide them for customers
      if (simBtn) simBtn.style.display = "none";
      if (stopBtn) stopBtn.style.display = "none";
      // Ensure any running preview is stopped
      stopDrone();
    }

    const pts = [base];
    if (pickup) pts.push(pickup);
    if (delivery) pts.push(delivery);
    fitMapToPoints(pts);
  } catch (e) {
    console.error(e);
  }
}

// ---------- Refresh ----------
async function refreshEstimateAndMap() {
  const pickupPoint = readCoords("pickup");
  const deliveryPoint = readCoords("delivery");
  const base = getDroneBase();

  if (state.map) ensureMarker("base", base, "Drone base");

  if (pickupPoint) {
    setGmapsLink("pickup", pickupPoint);
    if (state.geocoder) scheduleAddressUpdate("pickup", pickupPoint);
    if (state.map) ensureMarker("pickup", pickupPoint, "Pickup");
  }
  if (deliveryPoint) {
    setGmapsLink("delivery", deliveryPoint);
    if (state.geocoder) scheduleAddressUpdate("delivery", deliveryPoint);
    if (state.map) ensureMarker("delivery", deliveryPoint, "Delivery");
  }

  if (pickupPoint && deliveryPoint) {
    updateEstimateUIFromPoints(pickupPoint, deliveryPoint);
    if (state.line) state.line.setPath([pickupPoint, deliveryPoint]);
  } else {
    qs("#estimateBadge").textContent = "Estimate: —";
    if (state.line) state.line.setPath([]);
  }

  updateRouteLine();
}

// ---------- Create order ----------
async function createOrder() {
  const statusHint = qs("#statusHint");
  statusHint.textContent = "Submitting order…";

  const firstName = qs("#firstName").value.trim();
  const lastName = qs("#lastName").value.trim();
  const name = `${firstName} ${lastName}`.trim();
  const phone = qs("#phone").value.trim();
  const email = qs("#email").value.trim();
  const notes = qs("#notes").value.trim();

  const { deliveryType, weightKg, pickupPoint, deliveryPoint } = currentSelection();

  if (!firstName) return (statusHint.textContent = "Enter your first name.");
  if (!lastName) return (statusHint.textContent = "Enter your last name.");
  if (!phone || phone.length < 6) return (statusHint.textContent = "Enter a valid phone number.");
  if (!email || !email.includes("@")) return (statusHint.textContent = "Enter a valid email address.");
  if (!deliveryType) return (statusHint.textContent = "Could not auto-detect delivery type. Check weight and addresses.");
  if (!pickupPoint || !deliveryPoint) return (statusHint.textContent = "Enter valid pickup and delivery coordinates (or search addresses).");
  if (samePoint(pickupPoint, deliveryPoint)) return (statusHint.textContent = "Pickup and delivery cannot be the same location.");

  const estObj = computeEstimate(pickupPoint, deliveryPoint);
  const base = getDroneBase();

  const payload = {
    customerName: name,
    phone,
    email,
    base: { lat: base.lat, lng: base.lng },
    pickup: { id: null, label: "Pickup", lat: pickupPoint.lat, lng: pickupPoint.lng },
    delivery: { id: null, label: "Delivery", lat: deliveryPoint.lat, lng: deliveryPoint.lng },
    packageWeightKg: weightKg,
    packageDimensions: { lengthCm: currentSelection().pkgLength, widthCm: currentSelection().pkgWidth, heightCm: currentSelection().pkgHeight },
    deliveryType: deliveryType.id,
    notes,
    estimate: estObj ? { km: estObj.km, priceNok: estObj.est } : null
  };

  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    statusHint.textContent = data.error || "Something went wrong.";
    return;
  }

  const created = await res.json();
  statusHint.textContent = `Order created! Redirecting to payment…`;
  location.href = `payment.html?id=${encodeURIComponent(created._id)}`;
}

// ---------- Main ----------
(async function main() {
  ensureAuthOrRedirect();

  const me = await fetchMe().catch(() => null);
  if (me && me.role === "admin") {
    const hint = document.querySelector("#statusHint");
    if (hint) hint.textContent = "Admins cannot create orders. Redirecting to Admin…";
    location.href = "orders.html";
    return;
  }

  // Customer: hide drone preview buttons (simulate/stop)
  // (We still allow pickup/delivery picking and map usage.)
  const simBtn = q("#simulateDroneBtn");
  const stopBtn = q("#stopDroneBtn");
  if (simBtn) simBtn.style.display = "none";
  if (stopBtn) stopBtn.style.display = "none";

  await loadNfzZones();
  await loadServices();

  // Defaults for easier testing (near base)
  const base = getDroneBase();
  if (!qs("#pickupLat").value && !qs("#pickupLng").value) {
    qs("#pickupLat").value = base.lat.toFixed(4);
    qs("#pickupLng").value = base.lng.toFixed(4);
  }
  if (!qs("#deliveryLat").value && !qs("#deliveryLng").value) {
    qs("#deliveryLat").value = (base.lat + 0.01).toFixed(4);
    qs("#deliveryLng").value = (base.lng + 0.01).toFixed(4);
  }

  // initMapIfPossible is called with enableDronePreview=false for customers
  await initMapIfPossible({ enableDronePreview: false });
  autoSelectDeliveryType();
  await refreshEstimateAndMap();

  const coordIds = ["#pickupLat", "#pickupLng", "#deliveryLat", "#deliveryLng"];
  coordIds.forEach(sel => {
    qs(sel).addEventListener("input", debounce(() => { autoSelectDeliveryType(); refreshEstimateAndMap(); }, 150));
    qs(sel).addEventListener("change", () => { autoSelectDeliveryType(); refreshEstimateAndMap(); });
  });

  qs("#weight").addEventListener("change", () => { autoSelectDeliveryType(); refreshEstimateAndMap(); });
  qs("#weight").addEventListener("input", debounce(() => { autoSelectDeliveryType(); refreshEstimateAndMap(); }, 150));

  // Dimension inputs – also trigger drone type re-selection
  ["#pkgLength", "#pkgWidth", "#pkgHeight"].forEach(sel => {
    qs(sel).addEventListener("input", debounce(() => { autoSelectDeliveryType(); checkBasketFit(); }, 150));
    qs(sel).addEventListener("change", () => { autoSelectDeliveryType(); checkBasketFit(); });
  });

  qs("#createOrderBtn").addEventListener("click", createOrder);
})();

// Debounce helper
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}