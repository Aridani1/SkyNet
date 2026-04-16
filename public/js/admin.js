// public/js/admin.js

let current = null;
let cachedOrders = [];
let _charts = { status: null, etaByType: null };

function qs(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
function qsm(sel) {
  return document.querySelector(sel); // optional
}

function setStatus(el, msg, kind = "") {
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--danger)" : "var(--muted)";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

async function login() {
  const status = qsm("#loginStatus");
  setStatus(status, "Logging inâ€¦");

  const username = (qsm("#username")?.value || "").trim();
  const password = qsm("#password")?.value || "";

  if (!username || !password) return setStatus(status, "Enter username and password.", "error");

  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return setStatus(status, data.error || "Could not log in.", "error");
  }

  const data = await res.json().catch(() => ({}));
  if (data.user?.role !== "admin") {
    clearAuth();
    return setStatus(status, "This user is not an admin.", "error");
  }

  setAuth(data.token, data.user);
  setStatus(status, "OK! Loading admin panelâ€¦");

  const loginCard = qsm("#loginCard");
  const adminPanel = qsm("#adminPanel");
  if (loginCard) loginCard.style.display = "none";
  if (adminPanel) adminPanel.style.display = "block";

  await boot();
}

// ---------------- Orders UI ----------------

function cardOrder(o) {
  const div = document.createElement("div");
  div.className = "kpi";
  const canCancel = ["created", "awaiting_payment"].includes(o.status);
  const statusLabel = o.status === "awaiting_payment" ? "ðŸ’³ Awaiting payment"
    : o.status === "created" ? "ðŸ“ Created"
    : o.status === "accepted" ? "âœ… Accepted"
    : o.status === "in_transit" ? "âœˆï¸ In transit"
    : o.status === "returning" ? "ðŸ”„ Returning"
    : o.status === "delivered" ? "ðŸ“¦ Delivered"
    : o.status === "cancelled" ? "ðŸ›‘ Cancelled"
    : escapeHtml(o.status || "â€”");

  div.innerHTML = `
    <div>ðŸ“¦</div>
    <div style="width:100%">
      <b>#${escapeHtml(o._id)}</b>
      <span>${escapeHtml(o.customerName || "â€”")} â€¢ <b>${statusLabel}</b> â€¢ ${new Date(o.createdAt).toLocaleString("en-GB")}</span>
      <div class="hint">ETA: ${Number.isFinite(o.etaMinutes) ? o.etaMinutes : "â€”"} min${o.etaSource ? " (" + escapeHtml(o.etaSource) + ")" : ""} â€¢ Drone: ${escapeHtml(o.drone?.droneId || "â€”")}</div>
      ${o.loadTimeoutAlert && o.missionPhase === "awaiting_load" ? `<div class="badge danger" style="margin-top:4px; display:inline-block;">⚠️ Timeout >10m</div>` : ""}
      ${o.recall && ["timeout_auto_recall", "customer_cancel_at_pickup", "customer_no_load"].includes(o.recall.reason) ? `<div class="badge danger" style="margin-top:4px; display:inline-block;">🛑 Recalled at pickup (Charged)</div>` : ""}
      <div class="row" style="margin-top:8px; gap:6px; flex-wrap:wrap;">
        <a class="btn secondary" href="track.html?id=${encodeURIComponent(o._id)}">Track</a>
        <button class="btn" data-set="${escapeHtml(o._id)}">Select</button>
        ${o.loadTimeoutAlert ? `<button class="btn" data-msg="${escapeHtml(o._id)}">💬 Message Customer</button>` : ""}
        ${canCancel ? `<button class="btn danger" data-cancel="${escapeHtml(o._id)}">🛑 Cancel</button>` : ""}
      </div>
    </div>
  `;
  
  div.querySelector("[data-msg]")?.addEventListener("click", async () => {
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
      console.error(e);
      alert("Network error");
    }
  });
  div.querySelector("[data-set]")?.addEventListener("click", () => selectOrder(o._id));
  div.querySelector("[data-cancel]")?.addEventListener("click", async () => {
    if (!confirm(`Cancel order #${o._id} and release drone?`)) return;
    try {
      await fetch(`/api/orders/${encodeURIComponent(o._id)}/cancel`, {
        method: "POST",
        headers: { ...authHeaders() }
      });
      await loadOrders();
      await loadDrones();
    } catch (e) {
      console.error("Cancel failed:", e);
    }
  });
  return div;
}

async function loadOrders() {
  const res = await fetch("/api/orders", { headers: authHeaders() }).catch(() => null);

  // Some admin pages don't have orders list; still keep stats if any
  const box = qsm("#orders");

  if (!res || !res.ok) {
    if (box) box.textContent = "Could not load orders.";
    cachedOrders = [];
    renderStats();
    return;
  }

  const orders = await res.json().catch(() => []);
  cachedOrders = Array.isArray(orders) ? orders : [];
  renderStats();

  if (!box) return; // page doesn't show list
  box.innerHTML = "";

  if (!cachedOrders.length) {
    box.innerHTML = "<div class='hint'>No orders yet.</div>";
    return;
  }

  for (const o of cachedOrders) box.appendChild(cardOrder(o));
}

// ---------------- Stats ----------------

function renderStats() {
  const box = qsm("#statsBox");
  if (!box) return;

  const orders = Array.isArray(cachedOrders) ? cachedOrders : [];
  const total = orders.length;
  const withEta = orders.filter((o) => Number.isFinite(o.etaMinutes)).length;

  const byStatus = {};
  const byType = {};
  const bySource = {};
  const deliveredByType = { light: 0, heavy: 0, longrange: 0 };

  for (const o of orders) {
    const st = o.status || "unknown";
    byStatus[st] = (byStatus[st] || 0) + 1;

    // Normalize old delivery type IDs to new ones
    const typeMap = { standard: "light", express: "heavy", fragile: "longrange" };
    const t = typeMap[o.deliveryType] || o.deliveryType || "light";
    byType[t] = (byType[t] || 0) + 1;

    const src = o.etaSource || "unknown";
    bySource[src] = (bySource[src] || 0) + 1;

    if (Number.isFinite(o.etaMinutes)) {
      etaByType[t] = etaByType[t] || { sum: 0, n: 0 };
      etaByType[t].sum += o.etaMinutes;
      etaByType[t].n += 1;
    }
  }

  const delivered = byStatus.delivered || 0;
  const inTransit = byStatus.in_transit || 0;
  const cancelled = byStatus.cancelled || 0;

  const avgEta = (() => {
    const xs = orders.map((o) => o.etaMinutes).filter((x) => Number.isFinite(x));
    if (!xs.length) return null;
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.round(avg * 10) / 10;
  })();

  box.innerHTML = `
    <div class="kpi"><div>ðŸ“¦</div><div><b>${total}</b><span>Total orders</span></div></div>
    <div class="kpi"><div>â±ï¸</div><div><b>${avgEta ?? "â€”"}</b><span>Avg ETA (min)</span></div></div>
    <div class="kpi"><div>âœ…</div><div><b>${delivered}</b><span>Delivered</span></div></div>
    <div class="kpi"><div>ðŸšš</div><div><b>${inTransit}</b><span>In transit</span></div></div>
    <div class="kpi"><div>ðŸ›‘</div><div><b>${cancelled}</b><span>Cancelled</span></div></div>
    <div class="kpi"><div>ðŸ§ </div><div><b>${withEta}</b><span>Orders with ETA</span></div></div>
  `;

  // If Chart.js isn't loaded, stop.
  if (typeof Chart === "undefined") return;

  // Destroy old charts
  for (const k of Object.keys(_charts)) {
    try {
      _charts[k]?.destroy();
    } catch {}
    _charts[k] = null;
  }

  // Orders by status
  const statusLabels = Object.keys(byStatus);
  const statusData = statusLabels.map((k) => byStatus[k]);
  const ctxStatus = qsm("#chartStatus")?.getContext?.("2d");
  if (ctxStatus) {
    _charts.status = new Chart(ctxStatus, {
      type: "doughnut",
      data: { labels: statusLabels, datasets: [{ data: statusData }] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } } },
    });
  }

  // ETA by delivery type (avg)
  const typeNameMap = {
    light: "Light package", heavy: "Heavy package", longrange: "Long range",
    standard: "Light package", express: "Heavy package", fragile: "Long range"
  };
  const typeLabels = Object.keys(etaByType).map(t => typeNameMap[t] || t);
  const typeData = Object.keys(etaByType).map((t) => Math.round((etaByType[t].sum / etaByType[t].n) * 10) / 10);
  const ctxEta = qsm("#chartEtaByType")?.getContext?.("2d");
  if (ctxEta) {
    _charts.etaByType = new Chart(ctxEta, {
      type: "bar",
      data: { labels: typeLabels, datasets: [{ data: typeData, label: "Avg ETA (min)" }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }
}

// ---------------- Contacts (Unread / Read) ----------------

function cardContact(c) {
  const div = document.createElement("div");
  div.className = "kpi";

  const created = c.createdAt ? new Date(c.createdAt).toLocaleString("en-GB") : "â€”";
  const replied = c.repliedAt ? new Date(c.repliedAt).toLocaleString("en-GB") : "";
  const isUnread = c.adminUnread === true;

  div.innerHTML = `
    <div>âœ‰ï¸</div>
    <div style="width:100%">
      <div class="row" style="justify-content:space-between; align-items:center; gap:10px;">
        <div class="stack" style="gap:2px;">
          <b>${escapeHtml(c.name || "â€”")}</b>
          <span>${escapeHtml(c.email || "â€”")} â€¢ ${created}</span>
        </div>
        <div class="row" style="gap:10px; align-items:center;">
          ${
            isUnread
              ? `<span class="hint" style="color:var(--danger); font-weight:700;">â— ULest</span>`
              : `<span class="hint">Lest</span>`
          }
        </div>
      </div>

      <div class="hint" style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(c.message || "")}</div>

      <div class="card" style="padding:10px; margin-top:10px;">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <b>Reply</b>
          <span class="hint">${replied}</span>
        </div>

        <textarea data-reply="${escapeHtml(c._id)}"
          style="margin-top:8px; width:100%; min-height:90px;"
          placeholder="Write a reply to the customer...">${escapeHtml(c.adminReply || "")}</textarea>

        <div class="row" style="margin-top:8px; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          <button class="btn secondary" data-sendreply="${escapeHtml(c._id)}" type="button">Send reply</button>
        </div>
      </div>
    </div>
  `;

  const id = String(c._id || "");
  const btnReply = div.querySelector(`[data-sendreply="${CSS.escape(id)}"]`);
  const ta = div.querySelector(`textarea[data-reply="${CSS.escape(id)}"]`);

  btnReply?.addEventListener("click", async () => {
    const reply = String(ta?.value || "").trim();
    if (!reply) return alert("Reply cannot be empty.");

    btnReply.disabled = true;
    const old = btnReply.textContent;
    btnReply.textContent = "Sendingâ€¦";

    try {
      const res = await fetch(`/api/contacts/${encodeURIComponent(id)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ reply }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Could not send reply.");
      } else {
        await loadContacts();
      }
    } catch {
      alert("Could not send reply.");
    } finally {
      btnReply.disabled = false;
      btnReply.textContent = old;
    }
  });

  return div;
}

let _cachedContacts = [];

async function loadContacts(forceFetch = true) {
  const boxUnread = qsm("#contactsUnread");
  const boxRead = qsm("#contactsRead");

  if (!boxUnread || !boxRead) return;

  const hint = qsm("#contactsCountHint");
  const unreadCountEl = qsm("#unreadCount");
  const readCountEl = qsm("#readCount");

  if (forceFetch) {
    boxUnread.innerHTML = "<div class='hint'>Loading…</div>";
    boxRead.innerHTML = "";

    const res = await fetch("/api/contacts", { headers: authHeaders() }).catch(() => null);

    if (!res || !res.ok) {
      boxUnread.innerHTML = "<div class='hint'>Could not load contacts (check admin login).</div>";
      boxRead.innerHTML = "";
      if (hint) hint.textContent = "—";
      if (unreadCountEl) unreadCountEl.textContent = "—";
      if (readCountEl) readCountEl.textContent = "—";
      return;
    }

    const contacts = await res.json().catch(() => []);
    _cachedContacts = Array.isArray(contacts) ? contacts : [];
  }

  if (!_cachedContacts.length) {
    boxUnread.innerHTML = "<div class='hint'>No contacts yet. Test via the Contact page.</div>";
    boxRead.innerHTML = "";
    if (hint) hint.textContent = "Unread: 0 • Read: 0";
    if (unreadCountEl) unreadCountEl.textContent = "0";
    if (readCountEl) readCountEl.textContent = "0";
    return;
  }

  const unread = _cachedContacts.filter((c) => c.adminUnread === true);
  const read = _cachedContacts.filter((c) => c.adminUnread !== true);

  unread.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  read.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  if (unreadCountEl) unreadCountEl.textContent = String(unread.length);
  if (readCountEl) readCountEl.textContent = String(read.length);
  if (hint) hint.textContent = `Unread: ${unread.length} • Read: ${read.length}`;

  boxUnread.innerHTML = "";
  boxRead.innerHTML = "";

  if (!unread.length) {
    boxUnread.innerHTML = "<div class='hint'>No unread messages.</div>";
  }
  if (!read.length) {
    boxRead.innerHTML = "<div class='hint'>No read messages.</div>";
  }

  for (const c of unread) {
    const el = cardContact(c);
    el.dataset.searchid = c._id;
    boxUnread.appendChild(el);
  }
  for (const c of read) {
    const el = cardContact(c);
    el.dataset.searchid = c._id;
    boxRead.appendChild(el);
  }

  applyContactSearchFilter();
}

function applyContactSearchFilter() {
  const q = (qsm("#contactSearch")?.value || "").trim().toLowerCase();
  
  const allCards = document.querySelectorAll("#contactsUnread > .kpi, #contactsRead > .kpi");
  
  allCards.forEach(card => {
    let show = true;
    if (q) {
      const id = card.dataset.searchid;
      const c = _cachedContacts.find(x => x._id === id);
      if (c) {
        const n = (c.name || "").toLowerCase();
        const e = (c.email || "").toLowerCase();
        show = n.includes(q) || e.includes(q);
      }
    }
    card.style.display = show ? "" : "none";
  });
}

// ---------------- Drones ----------------

function cardDrone(d) {
  const div = document.createElement("div");
  div.className = "kpi";
  const batt = Math.round(d.battery ?? 0);
  const type = d.droneType || "light";
  const rangeKey = type === "heavy" ? "rangeKmHeavy" : type === "longrange" ? "rangeKmLongrange" : "rangeKmLight";
  const rangeVal = Number.isFinite(d[rangeKey]) ? d[rangeKey].toFixed(1) : "â€”";
  const isCharging = d.status === "charging";
  const isOnMission = ["in flight", "returning", "awaiting_load", "accepted"].includes(d.status);
  const isBusy = isOnMission || d.status === "assigned";

  const battColor = batt > 60 ? "#22c55e" : batt > 25 ? "#eab308" : "#ef4444";

  const typeLabel = type === "heavy" ? "ðŸ‹ï¸ Heavy"
    : type === "longrange" ? "ðŸŒ Long Range"
    : "ðŸ“¦ Light";

  const statusIcon = isCharging ? "âš¡ Charging"
    : d.status === "in flight" ? "âœˆï¸ In Flight"
    : d.status === "returning" ? "ðŸ”„ Returning"
    : d.status === "awaiting_load" ? "â³ Awaiting Load"
    : d.status === "assigned" ? "ðŸ“‹ Assigned"
    : d.status === "idle" ? "âœ… Idle"
    : escapeHtml(d.status || "â€”");

  div.innerHTML = `
    <div>ðŸš</div>
    <div style="width:100%">
      <b>${escapeHtml(d.droneId || "â€”")}</b> <span class="pill" style="font-size:0.75em; vertical-align:middle;">${typeLabel}</span>
      <span>Status: <b>${statusIcon}</b> â€¢ Battery: <b>${batt}%</b> â€¢ Range: ~${rangeVal} km</span>
      <div style="margin-top:6px; background:rgba(255,255,255,0.1); border-radius:6px; height:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.15);">
        <div style="width:${batt}%; height:100%; background:${battColor}; border-radius:4px; transition:width 0.8s ease;"></div>
      </div>
      ${isCharging ? `<div class="hint" style="margin-top:2px;">âš¡ Auto-chargingâ€¦ ${batt}%</div>` : ""}
      ${isOnMission ? `<div class="hint" style="margin-top:2px;">ðŸ”‹ ${batt}% remaining</div>` : ""}
      <div class="row" style="margin-top:8px; gap:8px; flex-wrap:wrap;">
        <button class="btn secondary" data-recharge="1"${isBusy ? " disabled" : ""}>ðŸ”‹ Swap Battery</button>
      </div>
      ${d.assignedOrderId ? `<div class="hint" style="margin-top:6px;">Assigned to order: ${escapeHtml(d.assignedOrderId)}</div>` : ""}
    </div>
  `;

  div.querySelector("[data-recharge]")?.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/drones/${encodeURIComponent(d.droneId)}/recharge`, {
        method: "POST",
        headers: { ...authHeaders() },
      });
      await res?.json?.().catch(() => ({}));
      await loadDrones();
    } catch {}
  });

  return div;
}

let _droneRefreshTimer = null;
let _lastDroneJson = "";

function startDroneAutoRefresh() {
  if (_droneRefreshTimer) return;
  _droneRefreshTimer = setInterval(() => loadDrones(), 3000);
}

async function loadDrones() {
  const box = qsm("#drones");
  if (!box) return;

  // Only show "Loadingâ€¦" on very first load
  if (!box.children.length || (box.children.length === 1 && box.querySelector(".hint"))) {
    box.innerHTML = "<div class='hint'>Loadingâ€¦</div>";
  }

  const res = await fetch("/api/drones", { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) {
    box.textContent = "Could not load drones.";
    return;
  }

  const drones = await res.json().catch(() => []);
  if (!Array.isArray(drones) || !drones.length) {
    box.innerHTML = "<div class='hint'>No drones in inventory.</div>";
    _lastDroneJson = "";
    return;
  }

  // Skip DOM rebuild if data hasn't changed
  const json = JSON.stringify(drones);
  if (json === _lastDroneJson) {
    // Still manage refresh timer
    const needsRefresh = drones.some((d) => d.status === "charging" || d.status === "in flight" || d.status === "returning" || d.status === "awaiting_load" || d.status === "assigned");
    if (needsRefresh) startDroneAutoRefresh();
    else { clearInterval(_droneRefreshTimer); _droneRefreshTimer = null; }
    return;
  }
  _lastDroneJson = json;

  box.innerHTML = "";
  for (const d of drones) box.appendChild(cardDrone(d));

  // Auto-refresh while any drone is charging or on mission
  const needsRefresh = drones.some((d) => d.status === "charging" || d.status === "in flight" || d.status === "returning" || d.status === "awaiting_load" || d.status === "assigned");
  if (needsRefresh) startDroneAutoRefresh();
  else { clearInterval(_droneRefreshTimer); _droneRefreshTimer = null; }
}

// ---------------- Select / Actions ----------------

async function selectOrder(id) {
  const orderIdEl = qsm("#orderId");
  if (orderIdEl) orderIdEl.value = id;

  const trackLink = qsm("#trackLink");
  if (trackLink) trackLink.href = `track.html?id=${encodeURIComponent(id)}`;

  const hint = qsm("#statusHint") || { textContent: "", style: {} };
  setStatus(hint, "Loading orderâ€¦");

  const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) {
    current = null;
    setStatus(hint, "Order not found.", "error");
    return;
  }

  current = await res.json().catch(() => null);
  if (!current) {
    setStatus(hint, "Order not found.", "error");
    return;
  }

  const statusSel = qsm("#statusSel");
  if (statusSel) statusSel.value = current.status;

  const mission = qsm("#missionInfo");
  if (mission) {
    mission.textContent =
      current.status === "in_transit"
        ? `Mission: ${Math.round((current.progress || 0) * 100)}% â€¢ ETA ${current.etaMinutes ?? "â€”"} min â€¢ Battery ${Math.round(current.drone?.battery ?? 0)}%`
        : current.status === "awaiting_payment"
        ? `Mission: â³ Awaiting customer payment`
        : `Mission: â€”`;
  }

  setStatus(hint, `Selected order #${current._id}.`);
}

async function callAdminAction(action) {
  const hint = qsm("#statusHint") || { textContent: "", style: {} };
  if (!current) return setStatus(hint, "Load an order first.", "error");
  setStatus(hint, "Executingâ€¦");

  const res = await fetch(`/api/orders/${encodeURIComponent(current._id)}/${action}`, {
    method: "POST",
    headers: { ...authHeaders() },
  }).catch(() => null);

  const data = await res?.json?.().catch(() => ({}));
  if (!res || !res.ok) {
    return setStatus(hint, data?.error || "Action failed.", "error");
  }

  current = data;
  const statusSel = qsm("#statusSel");
  if (statusSel) statusSel.value = current.status;

  setStatus(hint, `OK: ${action}. Status=${current.status}`);

  await loadOrders();
  await loadContacts();
  await loadDrones();
}

async function applyFromSelect() {
  const desired = qsm("#statusSel")?.value;
  if (!current || !desired) return;
  if (desired === current.status) return;

  if (desired === "accepted") return callAdminAction("accept");
  if (desired === "in_transit") return callAdminAction("start");
  if (desired === "cancelled") return callAdminAction("cancel");

  const hint = qsm("#statusHint");
  setStatus(hint, "For 'delivered': start mission and let it finish automatically.", "error");
}

// ---------------- Boot ----------------

async function boot() {
  await loadOrders();
  await loadContacts();
  await loadDrones();

  const preset = getParam("id");
  if (preset) selectOrder(preset);
}

// ---------------- Wire UI ----------------

qsm("#loginBtn")?.addEventListener("click", () => login().catch(() => {}));

qsm("#loadBtn")?.addEventListener("click", () => {
  const id = (qsm("#orderId")?.value || "").trim();
  if (id) selectOrder(id);
});

qsm("#updateBtn")?.addEventListener("click", () => applyFromSelect().catch(() => {}));

qsm("#acceptBtn")?.addEventListener("click", () => callAdminAction("accept"));
qsm("#startBtn")?.addEventListener("click", () => callAdminAction("start"));
qsm("#stopBtn")?.addEventListener("click", () => callAdminAction("stop"));
qsm("#cancelBtn")?.addEventListener("click", () => callAdminAction("cancel"));

qsm("#refreshOrdersBtn")?.addEventListener("click", () => loadOrders().catch(() => {}));
qsm("#refreshDronesBtn")?.addEventListener("click", () => loadDrones().catch(() => {}));

const searchInput = qsm("#contactSearch");
if (searchInput) {
  searchInput.addEventListener("input", applyContactSearchFilter);
}

// If already logged in, show admin panel immediately
(function init() {
  fetchMe()
    .then((me) => {
      if (me && me.role === "admin") {
        const loginCard = qsm("#loginCard");
        const adminPanel = qsm("#adminPanel");
        if (loginCard) loginCard.style.display = "none";
        if (adminPanel) adminPanel.style.display = "block";
        boot();
      }
    })
    .catch(() => {});
})();

// ============ FLEET RADAR (admin-fleet page) ============
(function initFleetRadar() {
  const canvas = document.querySelector("#fleetRadar");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const tooltip = document.querySelector("#fleetRadarTooltip");

  let dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  let lastCssW = 0, lastCssH = 0;

  function resize() {
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 360;
    if (cssW === lastCssW && cssH === lastCssH) return;
    lastCssW = cssW; lastCssH = cssH;
    dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const BASE = { lat: 59.3688, lng: 10.4416 };

  function hKm(a, b) {
    const toRad = d => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function toXY(point, cx, cy, maxR, maxKm) {
    if (!point) return null;
    const km = hKm(BASE, point);
    if (km < 0.001) return { x: cx, y: cy, km: 0 };
    const scale = Math.min(1, km / maxKm) * maxR;
    const dLng = (point.lng - BASE.lng) * Math.PI / 180;
    const lat1 = BASE.lat * Math.PI / 180;
    const lat2 = point.lat * Math.PI / 180;
    const yy = Math.sin(dLng) * Math.cos(lat2);
    const xx = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const bearing = Math.atan2(yy, xx);
    return { x: cx + Math.sin(bearing) * scale, y: cy - Math.cos(bearing) * scale, km };
  }

  const dots = [];
  let _allDrones = [];

  async function refreshDroneList() {
    try {
      const res = await fetch("/api/drones", { headers: authHeaders() });
      if (res.ok) _allDrones = await res.json();
    } catch {}
  }
  setInterval(refreshDroneList, 5000);
  refreshDroneList();

  canvas.addEventListener("mousemove", (e) => {
    if (!tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const d of dots) {
      const dx = mx - d.x, dy = my - d.y;
      if (dx * dx + dy * dy < (d.r + 8) * (d.r + 8)) { found = d; break; }
    }

    if (found && found.info) {
      tooltip.innerHTML = found.info;
      tooltip.style.display = "block";
      tooltip.style.left = Math.min(mx + 14, rect.width - 200) + "px";
      tooltip.style.top = (my - 10) + "px";
    } else {
      tooltip.style.display = "none";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (tooltip) tooltip.style.display = "none";
  });

  let t = 0;
  const ACTIVE = new Set(["in_transit", "returning", "awaiting_load", "created"]);

  function draw() {
    resize();
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = w / dpr, ch = h / dpr;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, cw, ch);

    const cx = cw * 0.5, cy = ch * 0.52;
    const maxR = Math.min(cw, ch) * 0.42;

    // Active drone positions from orders
    const dronePos = {}, droneOrd = {};
    if (Array.isArray(cachedOrders)) {
      for (const o of cachedOrders) {
        if (!o.drone?.droneId || !o.dronePosition) continue;
        if (!ACTIVE.has(o.status)) continue;
        dronePos[o.drone.droneId] = o.dronePosition;
        droneOrd[o.drone.droneId] = o;
      }
    }

    let maxKm = 5;
    for (const id in dronePos) {
      const km = hKm(BASE, dronePos[id]);
      if (km > maxKm) maxKm = km;
    }
    maxKm = Math.max(3, maxKm * 1.3);

    // Rings
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(232,238,252,0.3)";
    ctx.font = "500 10px ui-sans-serif, system-ui";
    for (let i = 1; i <= 4; i++) {
      const rr = (maxR * i) / 4;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(`${(maxKm * i / 4).toFixed(1)} km`, cx + rr + 3, cy + 3);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath(); ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR); ctx.stroke();

    // Sweep
    const angle = (t * 0.02) % (Math.PI * 2);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    grad.addColorStop(0, "rgba(122,162,255,0.18)");
    grad.addColorStop(1, "rgba(122,162,255,0.00)");
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, maxR, -0.2, 0.2); ctx.closePath(); ctx.fill();
    ctx.restore();

    dots.length = 0;

    // Base
    ctx.fillStyle = "#7aa2ff";
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(232,238,252,0.8)";
    ctx.font = "600 11px ui-sans-serif, system-ui";
    ctx.fillText("BASE", cx + 10, cy + 4);

    // All drone IDs
    const allIds = new Set();
    for (const d of _allDrones) if (d.droneId) allIds.add(d.droneId);
    for (const id in droneOrd) allIds.add(id);

    const apiMap = {};
    for (const d of _allDrones) if (d.droneId) apiMap[d.droneId] = d;

    const activeIds = [], idleIds = [];
    for (const id of allIds) {
      if (dronePos[id]) activeIds.push(id); else idleIds.push(id);
    }

    // Active drones
    for (const droneId of activeIds) {
      const order = droneOrd[droneId];
      const dp = toXY(dronePos[droneId], cx, cy, maxR, maxKm);
      if (!dp) continue;

      const batt = Math.round(order?.drone?.battery ?? apiMap[droneId]?.battery ?? 100);
      const st = order?.status || "idle";
      const isActive = st === "in_transit" || st === "returning";

      let color = batt < 20 ? "#ef4444" : isActive ? "#eab308" : "#52ffa8";
      const r = isActive ? 6 + Math.sin(t * 0.08 + dp.x * 0.1) * 1.5 : 5;

      if (isActive) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(dp.x, dp.y, r, 0, Math.PI * 2); ctx.fill();
      if (isActive) ctx.restore();

      ctx.fillStyle = "rgba(232,238,252,0.85)";
      ctx.font = "700 10px ui-sans-serif, system-ui";
      ctx.fillText("ðŸš", dp.x - 7, dp.y - r - 3);

      dots.push({
        x: dp.x, y: dp.y, r: r + 5,
        info: `<b>ðŸš ${escapeHtml(droneId)}</b><br>Status: ${escapeHtml(st)}<br>Phase: ${escapeHtml(order?.missionPhase || "â€”")}<br>Battery: ${batt}%<br>Speed: ${order?.drone?.speedKmph ?? "â€”"} km/h<br>Order: ${escapeHtml(order?._id?.slice(0, 10) || "â€”")}<br>Distance: ${dp.km.toFixed(1)} km`
      });
    }

    // Idle drones around base
    const idleStep = (Math.PI * 2) / Math.max(1, idleIds.length);
    let idleAngle = -Math.PI / 2;
    const idleR = maxR * 0.1;

    for (const droneId of idleIds) {
      const api = apiMap[droneId] || {};
      const batt = Math.round(api.battery ?? 100);
      const st = api.status || "idle";
      const isCharging = st === "charging";

      const dx = cx + Math.cos(idleAngle) * idleR;
      const dy = cy + Math.sin(idleAngle) * idleR;
      idleAngle += idleStep;

      ctx.fillStyle = isCharging ? "#eab308" : batt < 20 ? "#ef4444" : "#52ffa8";
      ctx.beginPath(); ctx.arc(dx, dy, 4, 0, Math.PI * 2); ctx.fill();

      dots.push({
        x: dx, y: dy, r: 8,
        info: `<b>ðŸš ${escapeHtml(droneId)}</b><br>Status: ${escapeHtml(st)}<br>Battery: ${batt}%<br>At base`
      });
    }

    // Title & legend
    ctx.fillStyle = "rgba(232,238,252,0.85)";
    ctx.font = "600 13px ui-sans-serif, system-ui";
    ctx.fillText("FLEET RADAR", 12, 20);

    ctx.font = "500 10px ui-sans-serif, system-ui";
    ctx.fillStyle = "#52ffa8"; ctx.fillRect(12, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Idle", 24, 38);
    ctx.fillStyle = "#eab308"; ctx.fillRect(56, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Active / Charging", 68, 38);
    ctx.fillStyle = "#ef4444"; ctx.fillRect(170, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Low battery", 182, 38);
    ctx.fillStyle = "#7aa2ff"; ctx.fillRect(260, 30, 8, 8);
    ctx.fillStyle = "rgba(232,238,252,0.7)"; ctx.fillText("Base", 272, 38);

    ctx.fillStyle = "rgba(232,238,252,0.5)";
    ctx.font = "500 11px ui-sans-serif, system-ui";
    ctx.fillText(`${allIds.size} drones â€¢ ${activeIds.length} active`, cw - 150, 20);

    t++;
    requestAnimationFrame(draw);
  }
  draw();
})();

if (!window._wsHandlers) window._wsHandlers = [];
window._wsHandlers.push((data) => {
  if (data && (data.type === "order_update" || data.type === "order_new" || data.type === "order_delete")) {
    if (typeof refreshDroneList === "function") refreshDroneList();
  }
});
