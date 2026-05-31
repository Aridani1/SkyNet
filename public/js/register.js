// @AssaadMohammadAatfaYamlik
function nextUrl(){
  const n = getParam("next");
  return n ? String(n) : "index.html";
}

async function doRegister(){
  const status = qs("#status");
  setStatus(status, "Creating account…");

  const username = qs("#username").value.trim();
  const password = qs("#password").value;
  const password2 = qs("#password2").value;

  if (!username || username.length < 3) {
    return setStatus(status, "Username must be at least 3 characters.", "error");
  }
  if (!password || password.length < 6) {
    return setStatus(status, "Password must be at least 6 characters.", "error");
  }
  if (password !== password2) {
    return setStatus(status, "Passwords do not match.", "error");
  }

  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStatus(status, data.error || "Could not create account.", "error");

  setAuth(data.token, data.user);
  setStatus(status, "Account created!", "ok");
  location.href = nextUrl();
}

qs("#registerBtn").addEventListener("click", doRegister);

["#username", "#password", "#password2"].forEach(sel => {
  const el = qs(sel);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doRegister();
  });
});
