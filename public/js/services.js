async function loadServices() {
  const status = qs("#servicesStatus");
  setStatus(status, "Loading services…");

  try {
    // Admin should not use Services page
    const me = await fetchMe().catch(() => null);
    if (me && me.role === "admin") {
      location.href = "orders.html";
      return;
    }

    const res = await fetch("assets/services.json");
    if (!res.ok) throw new Error("Could not load services.json");
    const data = await res.json();

    const services = (data.deliveryTypes || []).map((t) => ({
      type: t.id,
      title: t.label,
      priceNok: t.baseNok,
      perKmNok: t.perKmNok,
      maxWeightKg: t.maxWeightKg || 20,
      description: `Base price ${fmtNok(t.baseNok)} + ${fmtNok(t.perKmNok)}/km (total trip). Weight surcharge: +${fmtNok(12)}/kg over 1 kg.`,
      features: ["Live tracking", "Status log", "ETA calculation"]
    }));

    const grid = qs("#servicesGrid");
    grid.innerHTML = "";

    services.forEach((s) => {
      const el = document.createElement("div");
      el.className = "card mini";
      el.innerHTML = `
        <h3>${s.title}</h3>
        <p class="muted">${s.description}</p>
        <div class="row">
          <div><span class="pill">Max ${s.maxWeightKg} kg</span></div>
          <div class="right"><strong>From ${fmtNok(s.priceNok)}</strong></div>
        </div>
        <ul class="bullets">
          ${s.features.map((f) => `<li>${f}</li>`).join("")}
        </ul>
      `;
      grid.appendChild(el);
    });

    // Single shared order button below the grid
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "text-align:center; margin-top:24px;";
    btnRow.innerHTML = `
      <a class="btn" href="order.html" style="font-size:1.1em; padding:14px 40px;">🚁 Order delivery</a>
      <p class="muted" style="margin-top:10px;">The system automatically selects the best drone based on your weight and distance.</p>
    `;
    grid.parentElement.appendChild(btnRow);

    setStatus(status, `${services.length} delivery options available.`);
  } catch (e) {
    console.error(e);
    setStatus(status, e.message || "Error while loading", "error");
  }
}

loadServices();
