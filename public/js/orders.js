function statusBadge(status) {
  const span = document.createElement("span");
  span.className = "badge";

  const labels = {
    awaiting_payment: "💳 Awaiting payment",
    created: "📝 Created",
    accepted: "✅ Accepted",
    in_transit: "✈️ In transit",
    returning: "🔄 Returning",
    delivered: "📦 Delivered",
    cancelled: "🛑 Cancelled"
  };
  span.textContent = labels[status] || status;

  if (status === "delivered") span.classList.add("ok");
  else if (status === "in_transit" || status === "returning") span.classList.add("warn");
  else if (status === "cancelled") span.classList.add("danger");
  else if (status === "awaiting_payment") span.classList.add("warn");

  return span;
}

function formatEta(o) {
  // Delivered → show actual delivery time (best for demo)
  if (o.status === "delivered") {
    if (typeof o.actualMinutes === "number" && isFinite(o.actualMinutes)) {
      return `${o.actualMinutes.toFixed(1)} min (actual)`;
    }
    return "Delivered";
  }

  // Cancelled
  if (o.status === "cancelled") {
    return "Cancelled";
  }

  // Active order → show ETA
  const eta = (typeof o.etaMinutes === "number" && isFinite(o.etaMinutes)) ? o.etaMinutes : null;
  if (eta === null) return "—";

  const src = o.etaSource ? ` (${o.etaSource})` : "";
  return `${eta} min${src}`;
}

let _isAdmin = false;

async function load() {
  ensureAuthOrRedirect();

  // Check if admin
  try {
    const me = await fetchMe().catch(() => null);
    _isAdmin = me && me.role === "admin";
  } catch {}

  // Hide internal statuses from customers
  if (!_isAdmin) {
    const statusSel = qs("#status");
    if (statusSel) {
      Array.from(statusSel.options).forEach(opt => {
        if (["created", "accepted", "awaiting_payment"].includes(opt.value)) {
          opt.style.display = "none";
          opt.disabled = true;
        }
      });
    }
  }

  const q = qs("#q").value.trim();
  const status = qs("#status").value;

  const url = new URL("/api/orders", location.origin);
  if (q) url.searchParams.set("q", q);
  if (status && status !== "all") url.searchParams.set("status", status);

  const res = await fetch(url.toString(), { headers: { ...authHeaders() } });
  const hint = qs("#hint");

  if (!res.ok) {
    hint.textContent = "Could not load orders.";
    return;
  }

  const orders = await res.json();
  const tbody = qs("#tbody");
  tbody.innerHTML = "";

  for (const o of orders) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = o._id;

    const tdCustomer = document.createElement("td");
    const emailStr = o.email ? `<br/><span class="hint">${o.email}</span>` : "";
    const noteStr = o.notes ? `<br/><span class="hint" style="color:var(--text);"><b style="color:var(--muted)">Note:</b> ${escapeHtml(o.notes)}</span>` : "";
    tdCustomer.innerHTML = `<b>${o.customerName ?? "—"}</b><br/><span class="hint">${o.phone ?? ""}</span>${emailStr}${noteStr}`;

    const tdRoute = document.createElement("td");
    tdRoute.innerHTML = `${o.pickup?.label || "—"}<br/>→ ${o.delivery?.label || "—"}`;

    const tdStatus = document.createElement("td");
    tdStatus.appendChild(statusBadge(o.status));
    if (o.loadTimeoutAlert && o.missionPhase === "awaiting_load") {
      const timeoutWarn = document.createElement("div");
      timeoutWarn.className = "badge danger";
      timeoutWarn.style.marginTop = "4px";
      timeoutWarn.textContent = "⚠️ Timeout >10m";
      tdStatus.appendChild(timeoutWarn);
    } else if (o.recall && ["timeout_auto_recall", "customer_cancel_at_pickup", "customer_no_load"].includes(o.recall.reason)) {
      const recallWarn = document.createElement("div");
      recallWarn.className = "badge danger";
      recallWarn.style.marginTop = "4px";
      recallWarn.textContent = "🛑 Recalled at pickup (Charged)";
      tdStatus.appendChild(recallWarn);
    }

    const tdEta = document.createElement("td");
    tdEta.textContent = formatEta(o);

    const tdTime = document.createElement("td");
    tdTime.textContent = o.createdAt ? new Date(o.createdAt).toLocaleString("en-GB") : "—";

    const tdActions = document.createElement("td");
    tdActions.style.display = "flex";
    tdActions.style.gap = "6px";
    tdActions.style.flexWrap = "wrap";
    
    const a = document.createElement("a");
    a.className = "btn secondary";
    a.textContent = "Track";
    a.href = `track.html?id=${encodeURIComponent(o._id)}`;
    tdActions.appendChild(a);

    if (_isAdmin && o.loadTimeoutAlert && o.missionPhase === "awaiting_load") {
      const msgBtn = document.createElement("button");
      msgBtn.className = "btn";
      msgBtn.textContent = "💬 Message Customer";
      msgBtn.addEventListener("click", async () => {
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
      tdActions.appendChild(msgBtn);
    }

    // Cancel button for admin (not for delivered/cancelled)
    const canCancel = _isAdmin && ["created", "awaiting_payment"].includes(o.status);
    if (canCancel) {
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn danger";
      cancelBtn.textContent = "🛑 Cancel";
      cancelBtn.addEventListener("click", async () => {
        if (!confirm(`Cancel order #${o._id} and release the drone?`)) return;
        try {
          const r = await fetch(`/api/orders/${encodeURIComponent(o._id)}/cancel`, {
            method: "POST",
            headers: { ...authHeaders() }
          });
          if (r.ok) {
            load(); // refresh list
          } else {
            const d = await r.json().catch(() => ({}));
            alert(d.error || "Cancel failed.");
          }
        } catch (e) {
          console.error("Cancel error:", e);
        }
      });
      tdActions.appendChild(cancelBtn);
    }

    [tdId, tdCustomer, tdRoute, tdStatus, tdEta, tdTime, tdActions].forEach(td => tr.appendChild(td));
    tbody.appendChild(tr);
  }

  hint.textContent = orders.length
    ? `${orders.length} orders.`
    : "No orders yet. Create one on the Order page.";
}

qs("#q").addEventListener("input", () => {
  clearTimeout(window._t);
  window._t = setTimeout(load, 250);
});
qs("#status").addEventListener("change", load);

if (!window._wsHandlers) window._wsHandlers = [];
window._wsHandlers.push((data) => {
  if (data && (data.type === "order_update" || data.type === "order_new" || data.type === "order_delete")) {
    clearTimeout(window._t);
    window._t = setTimeout(load, 250);
  }
});

load();
