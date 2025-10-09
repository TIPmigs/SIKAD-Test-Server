// server.js (ESM version)
import mqtt from "mqtt";
import admin from "firebase-admin";
import express from "express";
import crypto from "crypto";
import * as turf from "@turf/turf";
import fs from "fs";

// ==================== GEOFENCE ====================
const testPolygon = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [[
      [121.0155930051057, 14.784261952800392],
      [121.0159518006032, 14.784476636782188],
      [121.01560426774483, 14.784821997524404],
      [121.01533879125566, 14.784540419663301],
      [121.0155930051057, 14.784261952800392]
    ]]
  }
};

// ==================== FIREBASE INIT ====================
let serviceAccount;
if (process.env.FIREBASE_KEY_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
  console.log("🔑 Using FIREBASE_KEY_JSON from environment.");
} else {
  serviceAccount = JSON.parse(fs.readFileSync("./firebase-key.json", "utf8"));
  console.log("🔑 Using local firebase-key.json file.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://cit306-finalproject-default-rtdb.firebaseio.com/",
});

const rtdb = admin.database();
const firestore = admin.firestore();

// ==================== MQTT SETUP ====================
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
  client.subscribe("esp32/gps/#", (err) => {
    if (!err) console.log("📡 Subscribed to esp32/gps/#");
  });
});

// ==================== MQTT MESSAGE HANDLER ====================
client.on("message", async (topic, message) => {
  const payload = message.toString();
  console.log(`📩 Received [${topic}]:`, payload);

  try {
    const data = JSON.parse(payload);
    const parts = topic.split("/");
    const bikeId = parts[2] || "unknown";

    const gpsData = {
      latitude: data.latitude,
      longitude: data.longitude,
      timestamp: new Date().toISOString(),
    };

    // ✅ Always update RTDB latest GPS
    await rtdb.ref(`gpsData/${bikeId}/latest`).set(gpsData);
    console.log(`✅ Saved GPS for ${bikeId}:`, gpsData);

    // ---------- GEOFENCE ----------
    const point = turf.point([data.longitude, data.latitude]);
    const inside = turf.booleanPointInPolygon(point, testPolygon);

    if (inside) {
      console.log(`🚲 Bike ${bikeId} is INSIDE geofence ✅`);
    } else {
      console.log(`🚨 Bike ${bikeId} is OUTSIDE geofence ❌`);
      client.publish(
        `esp32/cmd/${bikeId}`,
        JSON.stringify({ command: "alert", reason: "out_of_bounds" })
      );
    }

    // ---------- RIDE LOGGING ----------
    const bikeRef = firestore.collection("bikes").doc(bikeId);
    const bikeSnap = await bikeRef.get();
    if (!bikeSnap.exists) return;

    const bikeData = bikeSnap.data();
    if (bikeData.isActive && bikeData.rentedBy && bikeData.activeRideId) {
      const rideId = bikeData.activeRideId;

      await firestore.collection("ride_logs").doc(rideId).update({
        points: admin.firestore.FieldValue.arrayUnion(gpsData),
      });

      console.log(`🗺️ Appended GPS point to ride ${rideId} for bike ${bikeId}`);
    }
  } catch (err) {
    console.error("❌ Failed to process message:", err.message);
  }
});

// ==================== EXPRESS API ====================
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ---------- Token Generator ----------
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

// ---------- Generate token ----------
app.get("/generate-token", async (req, res) => {
  const { bikeId, qrCode } = req.query;
  if (!bikeId || !qrCode) return res.status(400).json({ error: "Missing bikeId or qrCode" });

  const token = generateToken();
  const expiresAt = Date.now() + 5 * 60 * 1000;

  await firestore.collection("bikes").doc(bikeId)
    .collection("tokens").doc(token)
    .set({
      qrCode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
      used: false,
    });

  res.json({ token });
});

// ---------- Payment success ----------
app.get("/success", async (req, res) => {
  const { bikeId, qrCode, token, userId, rideTime, amount } = req.query;
  if (!bikeId || !qrCode || !token || !userId || !amount)
    return res.status(400).send("Missing parameters.");

  const tokenRef = firestore.collection("bikes").doc(bikeId)
    .collection("tokens").doc(token);
  const tokenSnap = await tokenRef.get();

  if (!tokenSnap.exists) return res.status(400).send("Invalid token.");
  const tokenData = tokenSnap.data();

  if (tokenData.used) return res.status(400).send("Token already used.");
  if (Date.now() > tokenData.expiresAt) return res.status(400).send("Token expired.");

  await tokenRef.update({ used: true });

  // 🔹 Create a new ride log
  const rideRef = await firestore.collection("ride_logs").add({
    bikeId,
    userId,
    startTime: admin.firestore.FieldValue.serverTimestamp(),
    endTime: null,
    points: [],
  });

  const rideId = rideRef.id;

  // 🔹 Mark bike as active and link rideId
  const qrRef = firestore.collection("bikes").doc(bikeId);
  await qrRef.update({
    status: "paid",
    isActive: true,
    rentedBy: userId,
    activeRideId: rideId,
  });

  // 🔹 Log payment (to a top-level "payments" collection)
  await firestore.collection("payments").add({
    uid: userId,
    paymentAccount: "miggy account",   // hardcoded for now
    paymentType: "gcash",
    paymentStatus: "successful",
    amount: req.query.amount || "unknown",  // from redirect param
    paymentDate: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 🔹 Notify ESP32
  const blinkPayload = { command: "blink", qrCode, userId };
  if (rideTime) blinkPayload.rideTime = rideTime;

  client.publish(`esp32/cmd/${bikeId}`, JSON.stringify(blinkPayload));
  console.log(`⬇️ Ride started for ${bikeId}, rideId: ${rideId}, rideTime: ${rideTime}, amount: ${amount}`);

  const redirectUrl = `myapp://main?payment_status=success&bikeId=${bikeId}&rideId=${rideId}&userId=${userId}`;
  res.redirect(redirectUrl);
});

// ---------- End ride ----------
app.post("/endRide", async (req, res) => {
  const { bikeId, qrCode, userId } = req.body;
  if (!bikeId || !userId || !qrCode)
    return res.status(400).json({ error: "Missing parameters" });

  try {
    const bikeRef = firestore.collection("bikes").doc(bikeId);
    const bikeSnap = await bikeRef.get();

    if (!bikeSnap.exists) return res.status(404).json({ error: "Bike not found" });
    const bikeData = bikeSnap.data();

    if (bikeData.activeRideId) {
      const rideRef = firestore.collection("ride_logs").doc(bikeData.activeRideId);
      await rideRef.update({
        endTime: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Ended ride ${bikeData.activeRideId}`);
    }

    await bikeRef.update({
      status: "available",
      isActive: false,
      rentedBy: null,
      activeRideId: null,
    });

    res.json({ success: true, message: "Ride ended successfully" });
  } catch (err) {
    console.error("❌ /endRide failed", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Lock bike ----------
app.post("/lockBike", async (req, res) => {
  const { bikeId } = req.body;
  if (!bikeId) return res.status(400).json({ error: "Missing bikeId" });

  try {
    client.publish(`esp32/cmd/${bikeId}`, JSON.stringify({ command: "lock" }));
    console.log(`🔒 Sent LOCK to bike ${bikeId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /lockBike failed", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Health check ----------
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running.");
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
