window.APP_CONFIG = window.APP_CONFIG || {};

// Google Maps
window.APP_CONFIG.GOOGLE_MAPS_API_KEY =
  window.APP_CONFIG.GOOGLE_MAPS_API_KEY || "AIzaSyBKyAWg089zFLbJVcMN1ZWUbxPmHd7UOic";

// Backwards compatible (some modules may read this)
window.GOOGLE_MAPS_API_KEY = window.APP_CONFIG.GOOGLE_MAPS_API_KEY;

// Drone base: Holsetgata 31, 2318 Hamar
window.APP_CONFIG.DRONE_BASE =
  window.APP_CONFIG.DRONE_BASE || { lat: 59.3688, lng: 10.4416 };

// Drone speed for map animation (meters per second). Example: 18 m/s ≈ 65 km/h
window.APP_CONFIG.DRONE_SPEED_MPS = window.APP_CONFIG.DRONE_SPEED_MPS || 18;

// Drone realism settings
window.APP_CONFIG.CRUISE_ALTITUDE_M = window.APP_CONFIG.CRUISE_ALTITUDE_M || 120;
window.APP_CONFIG.SENSOR_BUBBLE_RADIUS_M = window.APP_CONFIG.SENSOR_BUBBLE_RADIUS_M || 50;
