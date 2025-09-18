// server.js (ESM version)
import mqtt from "mqtt";
import admin from "firebase-admin";
import express from "express";

// ========== Firebase Setup ==========
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

// ========== Express Setup ==========
const app = express();
const PORT = process.env.PORT || 3000;

// Webhook must be raw (PayMongo requirement)
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    // Log raw body first
    console.log("📩 Raw webhook body:", req.body.toString());

    const event = JSON.parse(req.body.toString());

    // Log the full parsed object
    console.log("📩 Parsed webhook object:", JSON.stringify(event, null, 2));

    // Try to extract event type
    const eventType = event?.data?.attributes?.type || event?.type || "undefined";
    console.log("📩 Webhook event type detected:", eventType);

    if (eventType === "payment.paid") {
      client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
      console.log("✅ Payment successful → Blink command sent!");
    } else if (eventType === "payment.failed") {
      console.log("❌ Payment failed");
    } else {
      console.log("⚠️ Unknown or unsupported webhook event type");
    }

    // Always respond 200 to acknowledge receipt
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(400);
  }
});

// JSON middleware AFTER webhook
app.use(express.json());

// Endpoint to trigger ESP32 downlink manually
app.post("/blink", (req, res) => {
  client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
  console.log("⬇️ Sent downlink command: BLINK");
  res.json({ success: true, message: "Blink command sent to ESP32" });
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running.");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
