// server.js
import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import fs from "fs";
import mqtt from "mqtt";

const app = express();
const PORT = process.env.PORT || 80;

// ========== Firebase Setup ==========
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebase-key.json", "utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://cit306-finalproject-default-rtdb.firebaseio.com/"
});

const db = admin.database();
const gpsRef = db.ref("gpsData");

let latestData = null;

// Middleware
app.use(bodyParser.json());

// ========== Old HTTP Endpoint (still works for fallback) ==========
app.post("/gps", async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const gpsData = {
      created_at: new Date().toISOString(),
      latitude,
      longitude
    };

    await gpsRef.set(gpsData);
    latestData = gpsData;

    console.log("✅ GPS Data received via HTTP -> Firebase:", gpsData);
    res.json({ success: true, message: "Data stored", data: gpsData });
  } catch (error) {
    console.error("❌ Error saving GPS data:", error.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ========== MQTT Subscriber ==========
const brokerUrl = "mqtt://broker.hivemq.com:1883";
const client = mqtt.connect(brokerUrl, {
  clientId: "server_" + Math.random().toString(16).slice(2)
});

client.on("connect", () => {
  console.log("✅ Connected to MQTT broker");
  // subscribe to all bikes: sikad/+/gps
  client.subscribe("sikad/+/gps", (err) => {
    if (err) console.error("❌ Subscribe failed:", err);
    else console.log("📡 Subscribed to topic: sikad/+/gps");
  });
});

client.on("message", async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const { latitude, longitude } = payload;

    if (!latitude || !longitude) {
      console.warn("⚠️ Invalid payload:", payload);
      return;
    }

    const gpsData = {
      created_at: new Date().toISOString(),
      latitude,
      longitude,
      topic
    };

    await gpsRef.set(gpsData);
    latestData = gpsData;

    console.log("✅ GPS via MQTT -> Firebase:", gpsData);
  } catch (error) {
    console.error("❌ Error processing MQTT message:", error);
  }
});

// ========== Client API ==========
app.get("/latest-data", (req, res) => {
  if (latestData) {
    res.json({ success: true, data: latestData });
  } else {
    res.json({ success: false, message: "No data available yet." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
