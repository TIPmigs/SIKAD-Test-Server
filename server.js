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
  // subscribe to ALL bikes GPS topics
  client.subscribe("esp32/gps/#", (err) => {
    if (!err) console.log("📡 Subscribed to esp32/gps/#");
  });
});

client.on("message", async (topic, message) => {
  const payload = message.toString();
  console.log(`📩 Received [${topic}]:`, payload);

  try {
    const data = JSON.parse(payload);

    // extract bikeId from topic (esp32/gps/bike_001 → bike_001)
    const parts = topic.split("/");
    const bikeId = parts[2] || "unknown";

    const gpsData = {
      created_at: new Date().toISOString(),
      latitude: data.latitude,
      longitude: data.longitude,
    };

    // ✅ Save latest GPS under each bike
    await rtdb.ref(`gpsData/${bikeId}/latest`).set(gpsData);

    console.log(`✅ Saved GPS for ${bikeId}:`, gpsData);
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

app.get("/success", async (req, res) => {
  const { bikeId, qrCode, token, userId } = req.query;
  if (!bikeId || !qrCode || !token || !userId) {
    return res.status(400).send("Missing bikeId, qrCode, token, or userId.");
  }

  const tokenRef = firestore
    .collection("bikes")
    .doc(bikeId)
    .collection("tokens")
    .doc(token);
  const tokenSnap = await tokenRef.get();

  if (!tokenSnap.exists) return res.status(400).send("Invalid token.");

  const tokenData = tokenSnap.data();
  if (tokenData.used) return res.status(400).send("Token already used.");
  if (Date.now() > tokenData.expiresAt) return res.status(400).send("Token expired.");

  await tokenRef.update({ used: true });

  // Update QR doc with rentedBy
  const qrRef = firestore.collection("qr_codes").doc(qrCode);
  await qrRef.update({
    status: "paid",
    isActive: true,
    rentedBy: userId, // <-- NEW field
  });

  // Log payment
  await firestore.collection("bikes").doc(bikeId).collection("payments").add({
    token,
    qrCode,
    status: "success",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    rentedBy: userId,
  });

  // Send blink command to ESP32
  client.publish(`esp32/cmd/${bikeId}`, JSON.stringify({ command: "blink" }));
  console.log(`⬇️ Sent BLINK to bike ${bikeId}`);

  // Redirect to app
  const redirectUrl = `myapp://main?payment_status=success&bikeId=${bikeId}&token=${token}&userId=${userId}`;
  res.redirect(redirectUrl);
});

// Endpoint to end ride in Firestore
app.post("/endRide", async (req, res) => {
    const { bikeId, userId } = req.body;
    if (!bikeId || !userId) return res.status(400).json({ error: "Missing bikeId or userId" });

    try {
        const qrRef = firestore.collection("qr_codes").doc(bikeId);
        await qrRef.update({
            status: "available",
            isActive: false,
            rentedBy: null
        });

        res.json({ success: true, message: "Ride ended" });
    } catch (err) {
        console.error("❌ /endRide failed", err);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint to lock the bike
app.post("/lockBike", async (req, res) => {
    const { bikeId } = req.body;
    if (!bikeId) return res.status(400).json({ error: "Missing bikeId" });

    try {
        client.publish(`esp32/cmd/${bikeId}`, JSON.stringify({ command: "lock" }));
        console.log(`🔒 Sent LOCK to bike ${bikeId}`);
        res.json({ success: true, message: "Bike locked" });
    } catch (err) {
        console.error("❌ /lockBike failed", err);
        res.status(500).json({ error: err.message });
    }
});


// Health check
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
