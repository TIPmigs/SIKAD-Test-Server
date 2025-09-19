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

const rtdb = admin.database();
const gpsRef = rtdb.ref("gpsData");

const firestore = admin.firestore();

// ========== HiveMQ Setup ==========
const options = {
  host: "8cc8aa8a96bb432a8176c3457b76204c.s1.eu.hivemq.cloud",
  port: 8883,
  protocol: "mqtts",
  username: "esp32-client",
  password: "SikadRocks19!",
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
      longitude: data.longitude,
    };
    await gpsRef.set(gpsData);
    console.log("✅ Saved to Realtime DB:", gpsData);
  } catch (err) {
    console.error("❌ Failed to process message:", err.message);
  }
});

// ========== Express API ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------- Token Generator ----------
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

// Generate token for bike + QR
app.get("/generate-token", async (req, res) => {
  const { bikeId, qrCode } = req.query;
  if (!bikeId || !qrCode) {
    return res.status(400).json({ error: "Missing bikeId or qrCode" });
  }

  const token = generateToken();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  // Save token under bike
  await firestore
    .collection("bikes")
    .doc(bikeId)
    .collection("tokens")
    .doc(token)
    .set({
      qrCode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
      used: false,
    });

  res.json({ token });
});

// Payment success
app.get("/success", async (req, res) => {
  const { bikeId, qrCode, token } = req.query;
  if (!bikeId || !qrCode || !token) {
    return res.status(400).send("Missing bikeId, qrCode, or token.");
  }

  const tokenRef = firestore
    .collection("bikes")
    .doc(bikeId)
    .collection("tokens")
    .doc(token);
  const tokenSnap = await tokenRef.get();

  if (!tokenSnap.exists) {
    return res.status(400).send("Invalid token.");
  }

  const tokenData = tokenSnap.data();
  if (tokenData.used) return res.status(400).send("Token already used.");
  if (Date.now() > tokenData.expiresAt) return res.status(400).send("Token expired.");

  // ✅ Mark token as used
  await tokenRef.update({ used: true });

  // ✅ Update QR document status
  const qrRef = firestore.collection("qr_codes").doc(qrCode);
  await qrRef.update({
    status: "paid",
    isActive: true,
  });

  // ✅ Log payment under bike
  await firestore.collection("bikes").doc(bikeId).collection("payments").add({
    token,
    qrCode,
    status: "success",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ✅ Send blink command for specific bike
  client.publish(`esp32/cmd/${bikeId}`, JSON.stringify({ command: "blink" }));
  console.log(`⬇️ Sent BLINK to bike ${bikeId}`);

  // ✅ Redirect to mobile app
  const redirectUrl = `myapp://main?payment_status=success&bikeId=${bikeId}&token=${token}`;
  res.redirect(redirectUrl);
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
