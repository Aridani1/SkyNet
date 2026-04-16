// common.js

// Highlight current nav link
(function () {
  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const href = a.getAttribute("href");
    if (href === path) a.classList.add("active");
  });
})();

// -------- Auth client helpers (token stored in localStorage) --------
function getAuthToken() {
  return localStorage.getItem("authToken") || "";
}

function setAuth(token, user) {
  localStorage.setItem("authToken", token);
  localStorage.setItem("authUser", JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
}

function authHeaders() {
  const t = getAuthToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function fetchMe() {
  const t = getAuthToken();
  if (!t) return null;
  const res = await fetch("/api/auth/me", { headers: { ...authHeaders() } });
  if (!res.ok) return null;
  return res.json();
}

async function logout() {
  const t = getAuthToken();
  if (t) {
    await fetch("/api/auth/logout", { method: "POST", headers: { ...authHeaders() } }).catch(() => {});
  }
  clearAuth();
  location.href = "login.html";
}

function ensureAuthOrRedirect() {
  if (getAuthToken()) return;
  const next = encodeURIComponent(location.pathname.split("/").pop() || "index.html");
  location.href = `login.html?next=${next}`;
}

function ensureAdminOrRedirect(user) {
  if (user && user.role === "admin") return;
  const next = encodeURIComponent(location.pathname.split("/").pop() || "index.html");
  location.href = `login.html?next=${next}`;
}

// ------------------ NAV BADGE (Contacts unread) ------------------
// Adds a small red badge with number on a nav link (Contact / Messages)
function ensureBadgeStylesInjected() {
  if (document.getElementById("nav-badge-style")) return;
  const style = document.createElement("style");
  style.id = "nav-badge-style";
  style.textContent = `
    .nav-badge{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-width:18px;
      height:18px;
      padding:0 6px;
      margin-left:6px;
      border-radius:999px;
      font-size:12px;
      line-height:18px;
      color:#fff;
      background:#d11a2a;
      font-weight:700;
      vertical-align:middle;
    }
    .nav-badge.hidden{ display:none; }
  `;
  document.head.appendChild(style);
}

function findNavLinkByHref(href) {
  const links = document.querySelectorAll(".links a");
  for (const a of links) {
    const h = (a.getAttribute("href") || "").trim();
    if (h === href) return a;
  }
  return null;
}

function getOrCreateBadgeEl(anchorEl) {
  ensureBadgeStylesInjected();
  if (!anchorEl) return null;

  let badge = anchorEl.querySelector(".nav-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "nav-badge hidden";
    badge.textContent = "0";
    anchorEl.appendChild(badge);
  }
  return badge;
}

function setBadgeCount(anchorEl, count) {
  const badge = getOrCreateBadgeEl(anchorEl);
  if (!badge) return;

  const n = Number(count || 0);
  if (!n || n <= 0) {
    badge.textContent = "0";
    badge.classList.add("hidden");
    return;
  }
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.remove("hidden");
}

// ------------------ WebSocket client (push updates) ------------------
let _ws = null;
let _wsReady = false;

function wsUrlForToken(token) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

function connectWsIfNeeded() {
  const token = getAuthToken();
  if (!token) return null;

  // avoid duplicate
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return _ws;

  try {
    _wsReady = false;
    _ws = new WebSocket(wsUrlForToken(token));

    _ws.addEventListener("open", () => {
      _wsReady = true;
      // Subscribe to contacts badge counts
      try {
        _ws.send(JSON.stringify({ type: "subscribe_contacts" }));
      } catch {}
    });

    _ws.addEventListener("message", (ev) => {
      let data = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }

      // Contacts badge count
      if (data && data.type === "contacts_unread") {
        const count = Number(data.count || 0);
        applyContactsBadge(count);
      }
      
      // Pending orders badge count
      if (data && data.type === "pending_orders_count") {
        const count = Number(data.count || 0);
        applyPendingOrdersBadge(count);
      }


      // allow pages to hook into WS messages (supports multiple handlers)
      if (window._wsHandlers && window._wsHandlers.length) {
        for (const fn of window._wsHandlers) {
          try { fn(data); } catch {}
        }
      }
      // legacy single-handler fallback
      if (typeof window.onWsMessage === "function") {
        try { window.onWsMessage(data); } catch {}
      }
    });

    _ws.addEventListener("close", () => {
      _wsReady = false;
      // silent reconnect with small delay
      setTimeout(() => {
        if (getAuthToken()) connectWsIfNeeded();
      }, 1500);
    });

    _ws.addEventListener("error", () => {
      // ignore; close will trigger reconnect
    });

    return _ws;
  } catch {
    return null;
  }
}

async function applyContactsBadge(count) {
  // We decide which tab gets badge based on role
  const me = await fetchMe().catch(() => null);
  if (!me) return;

  // Customer: badge on Contact
  if (me.role === "customer") {
    const a = findNavLinkByHref("contact.html");
    setBadgeCount(a, count);
    return;
  }

  // Admin: badge on Messages
  if (me.role === "admin") {
    const a = findNavLinkByHref("admin-contacts.html");
    setBadgeCount(a, count);
    return;
  }
}

async function applyPendingOrdersBadge(count) {
  // If we already know we're not a customer, bail.
  // We can trust the initial fetchMe() from initAuthUi
  const meStr = localStorage.getItem("authUser");
  if (!meStr) return;
  try {
    const me = JSON.parse(meStr);
    if (me.role !== "customer") return;
  } catch { return; }

  const a = findNavLinkByHref("orders.html");
  setBadgeCount(a, count);
}

// Inject Login/Logout link + role-based nav visibility
(async function initAuthUi() {
  const links = document.querySelector(".links");
  if (!links) return;

  const me = await fetchMe().catch(() => null);
  const isAdmin = !!(me && me.role === "admin");

  // Hide admin pages unless admin
  [...links.querySelectorAll("a")].forEach((a) => {
    const href = (a.getAttribute("href") || "").trim();
    const isAdminPage = href === "admin.html" || href.startsWith("admin-");
    if (isAdminPage && !isAdmin) a.style.display = "none";
    
    // Guests shouldn't see order and tracking pages
    const isGuestHidden = ["order.html", "track.html", "orders.html", "contact.html"].includes(href);
    if (!me && isGuestHidden) a.style.display = "none";
  });

  // Admins operate/monitor; they should not place orders
  const orderA = [...links.querySelectorAll("a")].find((a) =>
    (a.getAttribute("href") || "").includes("order.html")
  );
  if (orderA && isAdmin) orderA.style.display = "none";

  // Admin does not need Services
  const servicesA = [...links.querySelectorAll("a")].find((a) =>
    (a.getAttribute("href") || "").includes("services.html")
  );
  if (servicesA && isAdmin) servicesA.style.display = "none";

  // Admin does not need Home
  const homeA = [...links.querySelectorAll("a")].find((a) => (a.getAttribute("href") || "") === "index.html");
  if (homeA && isAdmin) homeA.style.display = "none";

  // Admin does not need Contact
  const contactA = [...links.querySelectorAll("a")].find((a) =>
    (a.getAttribute("href") || "").includes("contact.html")
  );
  if (contactA && isAdmin) contactA.style.display = "none";

  // Add login/logout entry at the end
  const a = document.createElement("a");
  a.setAttribute("data-nav", "");

  if (me) {
    a.href = "#";
    a.textContent = `Logout (${me.username})`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      logout();
    });
  } else {
    const next = encodeURIComponent(location.pathname.split("/").pop() || "index.html");
    a.href = `login.html?next=${next}`;
    a.textContent = "Login";
  }

  links.appendChild(a);

  // Start WebSocket after UI init (only when logged in)
  if (me) connectWsIfNeeded();

  // ✅ REST fallback: fetch unread-count once on page load (prevents "stuck" badge)
  if (me) {
    try {
      const r = await fetch("/api/contacts/unread-count", { headers: authHeaders() });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        await applyContactsBadge(Number(data.count || 0));
      }
    } catch {}
    
    if (me.role === "customer") {
      try {
        const r2 = await fetch("/api/orders/pending-count", { headers: authHeaders() });
        if (r2.ok) {
          const data2 = await r2.json().catch(() => ({}));
          await applyPendingOrdersBadge(Number(data2.count || 0));
        }
      } catch {}
    }
  }
})();

function fmtNok(n) {
  try {
    return new Intl.NumberFormat("no-NO", { style: "currency", currency: "NOK" }).format(n);
  } catch {
    return `${n} NOK`;
  }
}

function qs(sel) {
  return document.querySelector(sel);
}
function qsa(sel) {
  return Array.from(document.querySelectorAll(sel));
}

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

function setStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--danger)" : "var(--muted)";
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}