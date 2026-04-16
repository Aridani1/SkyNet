# SkyNet – Drone Operations Platform

A complete, real-time drone delivery application allowing customers to place package orders and operators to monitor a live fleet via a robust admin control panel. Built for dynamic route tracking, modern web integrations, and safe operational procedures.

---

## ⚙️ Requirements

- **Node.js** v18 or newer → [nodejs.org](https://nodejs.org)
- A Firebase project with Firestore enabled.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment variables
Ensure you have a `.env` file in the root directory. Crucial variables include:
- `ADMIN_KEY`: The password used to access the admin interfaces.
- `OWM_API_KEY`: (Optional) OpenWeatherMap API key. If omitted, the system falls back to the free Open-Meteo API.
- Your Firebase service account credentials (either via a `serviceAccountKey.json` local file or encoded base64 env vars).

### 3. Start the Server
```bash
npm start
```
*or run `node server.js` directly.*

Open your browser to: **http://localhost:3000**

---

## 🔐 Login Modes

### Customer
Customers can casually register a new profile via the "Login" page linked on the front page.

### Admin
- **Username:** `admin`
- **Password:** *Whatever is set in your `ADMIN_KEY` environment variable.*

The unified admin suite includes:
- 📋 **Orders:** Process, cancel, and oversee historical orders.
- 🚁 **Fleet:** Monitor drone states, battery capacities, and physical coordinates.
- 📊 **Statistics:** Analytical breakdown of order statuses and drone usage.
- ✉️ **Messages:** Real-time customer communication center.

---

## 💡 Key Features

| Feature | Description |
|---|---|
| **Interactive Map Ordering** | Place pins inside dedicated geolocation bounds using Leaflet. |
| **Complete Telemetry Tracking** | Track your order live with altitude, ground speed, route lines, and simulated data. |
| **Strict Operational Safeguards** | Automated recall procedures and 15-minute wait limit timeouts at pickup locations. |
| **WebSocket Push Events** | All UI dashboards automatically refresh and animate states using a live WS connection. |
| **Weather Integrations** | Drones fetch real-time weather constraints depending on their physical coordinates. |
| **Scalable Database** | Connected natively to Firebase Firestore for production-grade document safety. |

---

## 💻 Tech Stack

- **Frontend:** Vanilla HTML, CSS, JavaScript, Leaflet (maps)
- **Backend:** Node.js, Express, `ws` (WebSockets)
- **Database:** Firebase Firestore
- **Externals:** Open-Meteo, Leaflet OSM
