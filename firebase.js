// firebase.js – Firebase Admin SDK initialization and Firestore collection references
const admin = require("firebase-admin");
const path = require("path");

// Load service account credentials
const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Firestore database reference
const db = admin.firestore();

// Collection references
const ordersCol = db.collection("orders");
const dronesCol = db.collection("drones");
const contactsCol = db.collection("contacts");
const usersCol = db.collection("users");

module.exports = { admin, db, ordersCol, dronesCol, contactsCol, usersCol };
