// server.js (ESM version)
import mqtt from "mqtt";
import admin from "firebase-admin";
import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

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
  client.subscribe("esp32/gps", err => {
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

// ========== Express Setup ==========
app.use(express.json());

// ===== In-memory token store =====
const tokenStore = {}; // { token: expirationTimestamp }
const TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Generate a one-time token
app.get("/generate-token", (req, res) => {
  const token = crypto.randomBytes(16).toString("hex");
  const expires = Date.now() + TOKEN_TTL_MS;
  tokenStore[token] = expires;

  console.log(`🗝️ Generated token: ${token} (expires in 2 min)`);
  res.json({ token });
});

// Webhook must be raw (PayMongo requirement)
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    const eventType = event?.data?.attributes?.type || event?.type || "undefined";

    console.log("📩 Webhook event type:", eventType);

    if (eventType === "payment.paid") {
      client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
      console.log("✅ Payment successful → Blink command sent!");
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(400);
  }
});

// Trigger ESP32 downlink manually
app.post("/blink", (req, res) => {
  client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
  console.log("⬇️ Sent downlink command: BLINK");
  res.json({ success: true, message: "Blink command sent to ESP32" });
});

// Payment success endpoint (validates one-time token)
app.get("/payment-success", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("Missing token");

  const expires = tokenStore[token];
  if (!expires || Date.now() > expires) {
    return res.status(400).send("Invalid or expired token");
  }

  // Token is valid → send blink command
  client.publish("esp32/cmd", JSON.stringify({ command: "blink" }));
  console.log(`✅ Blink command sent for token: ${token}`);

  // Invalidate token (one-time use)
  delete tokenStore[token];

  // Return simple HTML page
  res.send(`
    <html>
      <head>
        <title>Payment Successful</title>
        <meta charset="utf-8">
        <script>
          // After 2 seconds, try to go back to the app using a custom URL scheme
          setTimeout(() => {
            // Replace 'sikad://payment-success' with your app's intent URL scheme
            window.location.href = "sikad://payment-success";
          }, 2000);
        </script>
      </head>
      <body>
        <h1>✅ Payment Successful!</h1>
        <p>The ESP32 has received the blink command.</p>
        <p>Returning to the app shortly…</p>
      </body>
    </html>
  `);
});

// Health check
app.get("/", (req, res) => res.send("✅ Node.js MQTT server is running."));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
