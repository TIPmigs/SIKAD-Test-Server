// server.js (ESM version)
import mqtt from "mqtt";
import admin from "firebase-admin";
import express from "express";
import crypto from "crypto";

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://cit306-finalproject-default-rtdb.firebaseio.com/",
});

const db = admin.database();
const gpsRef = db.ref("gpsData");

// ========== HiveMQ Setup ==========
const options = {
  host: "8cc8aa8a96bb432a8176c3457b76204c.s1.eu.hivemq.cloud",
  port: 8883,
  protocol: "mqtts",
  username: "esp32-client",
  password: "SikadRocks19!"
};

const client = mqtt.connect(options);

client.on("connect", () => {
  console.log("✅ Connected to HiveMQ");
  client.subscribe("esp32/gps", (err) => {
    if (!err) console.log("📡 Subscribed to esp32/gps");
  });
});

client.on("message", async (topic, message) => {
  const payload = message.toString();
  console.log("📩 Received:", payload);

  try {
    const data = JSON.parse(payload);
    const gpsData = {
      created_at: new Date().toISOString(),
      latitude: data.latitude,
      longitude: data.longitude
    };
    await gpsRef.set(gpsData);
    console.log("✅ Saved to Firebase:", gpsData);
  } catch (err) {
    console.error("❌ Failed to process message:", err.message);
  }
});

// ========== Express API ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------- One-time Token Management ----------
const tokens = {}; // In-memory; use DB in production

function generateToken() {
  return crypto.randomBytes(16).toString("hex"); // 32-char token
}

// Endpoint for app to request a token
app.get("/generate-token", (req, res) => {
  const token = generateToken();
  tokens[token] = Date.now() + 5 * 60 * 1000; // 5 min expiry
  res.json({ token });
});

// Endpoint triggered by PayMongo redirect
app.get("/success", (req, res) => {
  const token = req.query.token;
  if (!token || !tokens[token]) return res.status(403).send("Invalid or expired token");
  if (Date.now() > tokens[token]) {
    delete tokens[token];
    return res.status(403).send("Token expired");
  }

  // Valid token → trigger blink
  client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
  console.log("⬇️ Sent downlink command: BLINK");

  delete tokens[token]; // enforce one-time use
  res.send("<h1>✅ Payment successful. Blink command sent.</h1>");
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
