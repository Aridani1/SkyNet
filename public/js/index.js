// Redirect admins away from the customer home page @Anwar
(async function () {
  const me = await fetchMe().catch(() => null);
  if (me && me.role === "admin") {
    location.href = "orders.html";
  }
})();
