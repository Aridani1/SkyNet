function nextUrl(){
  const n = getParam("next");
  return n ? String(n) : "index.html";
}

async function doLogin(){
  const status = qs("#status");
  setStatus(status, "Logging in…");

  const username = qs("#username").value.trim();
  const password = qs("#password").value;

  if (!username || !password) {
    return setStatus(status, "Enter username and password.", "error");
  }

  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStatus(status, data.error || "Could not log in.", "error");

  setAuth(data.token, data.user);
  setStatus(status, "OK!", "ok");
  location.href = nextUrl();
}

qs("#loginBtn").addEventListener("click", doLogin);

// Enter-to-login
["#username", "#password"].forEach(sel => {
  const el = qs(sel);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
});
