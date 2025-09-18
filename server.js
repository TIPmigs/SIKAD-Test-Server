// server.js (ESM version)
import mqtt from "mqtt";
import admin from "firebase-admin";
import fs from "fs";
import express from "express";

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

    // Push to Firebase
    await gpsRef.set(gpsData);
    console.log("✅ Saved to Firebase:", gpsData);
  } catch (err) {
    console.error("❌ Failed to process message:", err.message);
  }
});

// ========== Express API for Downlink ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint to trigger ESP32 downlink (LED blink 10s)
app.post("/blink", (req, res) => {
  const { token, status } = req.body;

  if (token !== "XYZ123") {
    console.log("❌ Invalid token, rejected request");
    return res.status(403).json({ success: false, message: "Invalid token" });
  }

  if (status === "success") {
    client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
    console.log("⬇️ Sent downlink command: BLINK");
    return res.json({ success: true, message: "Blink command sent to ESP32" });
  } else {
    return res.json({ success: false, message: "No blink sent" });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running.");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
