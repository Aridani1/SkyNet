// contact.js

function qs(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

function qsm(sel) {
  return document.querySelector(sel); // optional
}

function setStatus(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = "hint";
  if (type === "error") el.classList.add("danger");
  if (type === "ok") el.classList.add("ok");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prettyTime(ts) {
  try {
    return new Date(ts).toLocaleString("en-GB");
  } catch {
    return "";
  }
}

async function ensureCustomer() {
  const me = await fetchMe().catch(() => null);
  if (!me || me.role !== "customer") return null;
  return me;
}

// --- Badge helpers (from common.js) ---
// We reuse common.js functions if available:
// - applyContactsBadge(count)
// - findNavLinkByHref / setBadgeCount
async function refreshContactsBadgeFromRest() {
  try {
    const res = await fetch("/api/contacts/unread-count", { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const count = Number(data.count || 0);

    // If common.js has applyContactsBadge, use it
    if (typeof window.applyContactsBadge === "function") {
      await window.applyContactsBadge(count);
      return;
    }

    // Fallback: set badge directly (customer => contact.html)
    if (typeof window.findNavLinkByHref === "function" && typeof window.setBadgeCount === "function") {
      const a = window.findNavLinkByHref("contact.html");
      window.setBadgeCount(a, count);
    }
  } catch {
    // ignore
  }
}

async function markMyRepliesAsRead() {
  // Marks all customerUnread=true -> false
  try {
    const res = await fetch("/api/contacts/mine/mark-read", {
      method: "POST",
      headers: { ...authHeaders() }
    });
    if (!res.ok) return;
  } catch {
    // ignore
  }

  // Update badge immediately (in case WS push is delayed/not connected)
  await refreshContactsBadgeFromRest();
}

function renderCard(m) {
  const el = document.createElement("div");
  el.className = "card";
  el.style.padding = "12px";

  const isUnread = m.customerUnread === true && !!m.adminReply;

  const replyHtml = m.adminReply
    ? `
      <div class="card" style="padding:10px; margin-top:8px;">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <b>Admin reply</b>
          <span class="hint">${prettyTime(m.repliedAt)}</span>
        </div>
        <div class="hint" style="margin-top:6px; white-space:pre-wrap;">
          ${escapeHtml(m.adminReply)}
        </div>
      </div>
    `
    : `<div class="hint" style="margin-top:8px;">No reply yet.</div>`;

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:center;">
      <div class="stack" style="gap:2px;">
        <b>Your message</b>
        <span class="hint">${prettyTime(m.createdAt)}</span>
      </div>
      ${isUnread ? '<span class="hint" style="color:var(--danger); font-weight:700;">● NEW</span>' : ''}
    </div>
    <div class="hint" style="margin-top:6px; white-space:pre-wrap;">
      ${escapeHtml(m.message || "")}
    </div>
    ${replyHtml}
  `;
  return el;
}

async function loadMyMessages({ markRead = true } = {}) {
  const boxUnread = qs("#contactsUnread");
  const boxRead = qs("#contactsRead");
  const unreadCountEl = qsm("#unreadCount");
  const readCountEl = qsm("#readCount");

  boxUnread.innerHTML = "<div class='hint'>Loading…</div>";
  boxRead.innerHTML = "";

  const me = await ensureCustomer();
  if (!me) {
    boxUnread.innerHTML = "<div class='hint'>Log in to see your messages and admin replies.</div>";
    boxRead.innerHTML = "";
    return;
  }

  const res = await fetch("/api/contacts/mine", { headers: authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    boxUnread.innerHTML = `<div class='hint'>Could not load messages.${data.error ? " " + escapeHtml(data.error) : ""}</div>`;
    boxRead.innerHTML = "";
    return;
  }

  const list = await res.json().catch(() => []);
  if (!Array.isArray(list) || !list.length) {
    boxUnread.innerHTML = "<div class='hint'>No messages yet.</div>";
    boxRead.innerHTML = "";
    if (unreadCountEl) unreadCountEl.textContent = "0";
    if (readCountEl) readCountEl.textContent = "0";
    return;
  }

  const unread = list.filter((m) => m.customerUnread === true && !!m.adminReply);
  const read = list.filter((m) => !(m.customerUnread === true && !!m.adminReply));

  unread.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  read.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  if (unreadCountEl) unreadCountEl.textContent = String(unread.length);
  if (readCountEl) readCountEl.textContent = String(read.length);

  boxUnread.innerHTML = "";
  boxRead.innerHTML = "";

  if (!unread.length) boxUnread.innerHTML = "<div class='hint'>No unread messages.</div>";
  if (!read.length) boxRead.innerHTML = "<div class='hint'>No read messages.</div>";

  for (const m of unread) boxUnread.appendChild(renderCard(m));
  for (const m of read) boxRead.appendChild(renderCard(m));

  // ✅ IMPORTANT: mark replies as read when user opens/loads inbox
  if (markRead && unread.length > 0) {
    await markMyRepliesAsRead();
  }
}

async function send() {
  const hint = qs("#statusHint");
  setStatus(hint, "Sending…");

  const me = await ensureCustomer();
  if (!me) {
    return setStatus(hint, "Please log in as a customer before sending messages.", "error");
  }

  const name = qs("#name").value.trim();
  const email = (qsm("#email")?.value || "").trim();
  const message = qs("#message").value.trim();

  if (name.length < 2) return setStatus(hint, "Name must be at least 2 characters.", "error");
  if (!email.includes("@")) return setStatus(hint, "Enter a valid email address.", "error");
  if (message.length < 5) return setStatus(hint, "The message is too short.", "error");

  const res = await fetch("/api/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name, email, message })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return setStatus(hint, data.error || "Something went wrong.", "error");
  }

  setStatus(hint, "Sent! Thank you 😊", "ok");
  qs("#message").value = "";

  // Reload messages (and ensure badge is correct)
  await loadMyMessages({ markRead: true });
}

// Wire UI
qs("#sendBtn").addEventListener("click", () => send().catch(() => {}));

// init
ensureAuthOrRedirect();
loadMyMessages({ markRead: true }).catch(() => {});