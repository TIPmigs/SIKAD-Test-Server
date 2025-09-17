const mqtt = require("mqtt");
const admin = require("firebase-admin");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");

// ========== Firebase Setup ==========
const serviceAccount = JSON.parse(fs.readFileSync("./firebase-key.json", "utf-8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://cit306-finalproject-default-rtdb.firebaseio.com/"
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

// ========== Express Setup ==========
const app = express();
app.use(bodyParser.json());

// Payment success webhook
app.post("/payment-success", (req, res) => {
  console.log("💰 Payment authorized:", req.body);

  // Publish downlink to ESP32
  client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
  console.log("📡 Downlink sent: PAYMENT_OK");

  res.json({ status: "ok", message: "Command sent to ESP32" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
