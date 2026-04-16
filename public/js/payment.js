/* Payment page logic */

function getOrderId() {
  const u = new URL(location.href);
  return u.searchParams.get("id");
}

// Format card number with spaces
function formatCardNumber(val) {
  const digits = val.replace(/\D/g, "").slice(0, 16);
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

// Update card visual in real-time
function wireCardVisual() {
  const holder = document.getElementById("cardHolder");
  const number = document.getElementById("cardNumber");
  const expiry = document.getElementById("cardExpiry");
  const holderDisplay = document.getElementById("holderDisplay");
  const numberDisplay = document.getElementById("cardNumberDisplay");
  const expiryDisplay = document.getElementById("expiryDisplay");

  holder.addEventListener("input", () => {
    holderDisplay.textContent = holder.value.trim() || "YOUR NAME";
  });

  number.addEventListener("input", () => {
    number.value = formatCardNumber(number.value);
    numberDisplay.textContent = number.value || "•••• •••• •••• ••••";
  });

  expiry.addEventListener("input", () => {
    let v = expiry.value.replace(/\D/g, "").slice(0, 4);
    if (v.length > 2) v = v.slice(0, 2) + "/" + v.slice(2);
    expiry.value = v;
    expiryDisplay.textContent = v || "MM/YY";
  });

  // Init display from prefilled values
  if (number.value) numberDisplay.textContent = number.value;
  if (expiry.value) expiryDisplay.textContent = expiry.value;
}

// Load order and display summary
async function loadOrderSummary(orderId) {
  const summary = document.getElementById("orderSummary");

  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
      headers: { ...authHeaders() }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error("[PAYMENT] Order load failed:", res.status, errData);
      summary.innerHTML = `<div class="summary-row"><span style="color:var(--danger);">Could not load order: ${errData.error || res.status}</span></div>`;
      return null;
    }

    const order = await res.json();
    console.log("[PAYMENT] Order loaded:", order.status, order._id);

    const typeLabels = {
      light: "📦 Light package", heavy: "🏋️ Heavy package", longrange: "🌍 Long range",
      standard: "📦 Light package", express: "🏋️ Heavy package", fragile: "🌍 Long range"
    };
    const typeLabel = typeLabels[order.deliveryType] || order.deliveryType || "—";
    const km = order.estimate?.km ?? order.routeDistanceKm ?? null;
    const weight = order.packageWeightKg ?? 0;

    // Calculate price client-side if not stored
    let price = order.estimate?.priceNok ?? null;
    if (price === null && typeof km === "number") {
      const pricing = { light: { base: 49, perKm: 3 }, heavy: { base: 79, perKm: 4 }, longrange: { base: 119, perKm: 2.5 } };
      const p = pricing[order.deliveryType] || pricing.light;
      price = Math.round(p.base + p.perKm * km + Math.max(0, weight - 1) * 12);
    }

    // Pre-fill card holder name from order
    const holder = document.getElementById("cardHolder");
    if (holder && order.customerName) {
      holder.value = order.customerName;
      const holderDisplay = document.getElementById("holderDisplay");
      if (holderDisplay) holderDisplay.textContent = order.customerName.toUpperCase();
    }

    summary.innerHTML = `
      <div class="summary-row">
        <span>Order</span>
        <span style="font-family:monospace; font-size:12px;">${orderId.slice(0, 12)}…</span>
      </div>
      <div class="summary-row">
        <span>Delivery type</span>
        <span>${typeLabel}</span>
      </div>
      <div class="summary-row">
        <span>Total trip distance</span>
        <span>~${typeof km === "number" ? km.toFixed(1) : km} km</span>
      </div>
      <div class="summary-row">
        <span>Weight</span>
        <span>${weight} kg</span>
      </div>
      <div class="summary-row">
        <span>Customer</span>
        <span>${escapeHtml(order.customerName || "—")}</span>
      </div>
      <div class="summary-row total">
        <span>Total</span>
        <span>${typeof price === "number" ? fmtNok(price) : price}</span>
      </div>
    `;

    return order;
  } catch (err) {
    console.error("[PAYMENT] Exception loading order:", err);
    summary.innerHTML = `<div class="summary-row"><span style="color:var(--danger);">Error loading order.</span></div>`;
    return null;
  }
}

// Simulate payment
async function processPayment(orderId) {
  const payBtn = document.getElementById("payBtn");
  const paymentCard = document.getElementById("paymentCard");
  const processingCard = document.getElementById("processingCard");
  const successCard = document.getElementById("successCard");
  const status = document.getElementById("payStatus");

  try {
    // Validate fields
    const holder = document.getElementById("cardHolder").value.trim();
    const number = document.getElementById("cardNumber").value.replace(/\s/g, "");
    const expiry = document.getElementById("cardExpiry").value.trim();
    const cvc = document.getElementById("cardCvc").value.trim();

    if (!holder) { status.textContent = "Enter cardholder name."; return; }
    if (number.length < 16) { status.textContent = "Enter a valid card number."; return; }
    if (expiry.length < 4) { status.textContent = "Enter expiry date."; return; }
    if (cvc.length < 3) { status.textContent = "Enter CVC."; return; }

    // Show processing
    payBtn.disabled = true;
    status.textContent = "";
    paymentCard.style.display = "none";
    processingCard.classList.add("active");

    // Simulate processing delay
    await new Promise(r => setTimeout(r, 2000));

    // Call server to confirm payment
    console.log("[PAYMENT] Calling /api/orders/" + orderId + "/pay");
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() }
    });

    processingCard.classList.remove("active");

    if (!res.ok) {
      paymentCard.style.display = "block";
      payBtn.disabled = false;
      const data = await res.json().catch(() => ({}));
      console.error("[PAYMENT] Pay failed:", res.status, data);
      status.textContent = data?.error || "Payment failed. Try again.";
      return;
    }

    const result = await res.json();
    console.log("[PAYMENT] Payment success:", result);

    // Show success
    successCard.classList.add("active");
    document.getElementById("successOrderId").textContent = `Order ID: ${orderId}`;
    document.getElementById("trackLink").href = `track.html?id=${encodeURIComponent(orderId)}`;
  } catch (err) {
    console.error("[PAYMENT] Exception:", err);
    processingCard.classList.remove("active");
    paymentCard.style.display = "block";
    payBtn.disabled = false;
    status.textContent = "Payment error: " + (err.message || "Unknown error");
  }
}

// Main
(async function main() {
  ensureAuthOrRedirect();

  const orderId = getOrderId();
  if (!orderId) {
    document.getElementById("orderSummary").innerHTML =
      `<div class="summary-row"><span style="color:var(--danger);">No order ID provided.</span></div>`;
    return;
  }

  wireCardVisual();

  // Always attach button listeners first
  document.getElementById("payBtn").addEventListener("click", () => processPayment(orderId));

  document.getElementById("cancelPayBtn").addEventListener("click", async () => {
    if (!confirm("Cancel this order? It will be deleted and you can start over.")) return;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/abandon`, {
        method: "POST",
        headers: { ...authHeaders() }
      });
      if (res.ok) {
        location.href = "order.html";
      } else {
        const d = await res.json().catch(() => ({}));
        document.getElementById("payStatus").textContent = d.error || "Could not cancel.";
      }
    } catch (e) {
      document.getElementById("payStatus").textContent = "Error: " + (e.message || "Unknown");
    }
  });

  const order = await loadOrderSummary(orderId);

  // If already paid, redirect to track
  if (order && order.status !== "awaiting_payment") {
    location.href = `track.html?id=${encodeURIComponent(orderId)}`;
    return;
  }
})();
