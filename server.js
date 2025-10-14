// server.js (ESM version)
import mqtt from "mqtt";
import admin from "firebase-admin";
import express from "express";
import crypto from "crypto";
import * as turf from "@turf/turf";
import fs from "fs";

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

// ==================== GEOFENCE CACHE ====================
let cachedGeofences = [];
let lastCacheTime = 0;
const CACHE_DURATION = 60 * 1000; // 1 minute

async function getActiveGeofences() {
  const now = Date.now();
  if (cachedGeofences.length && now - lastCacheTime < CACHE_DURATION) {
    return cachedGeofences;
  }

  const geofenceSnap = await firestore.collection('geofence')
    .where('is_active', '==', true)
    .get();

  const geofences = [];

  geofenceSnap.forEach(doc => {
    const data = doc.data();
    if (data.points && data.points.length) {
      const coordinates = data.points.map(p => [p.location.longitude, p.location.latitude]);

      // close the polygon if not closed
      if (coordinates[0][0] !== coordinates[coordinates.length-1][0] ||
          coordinates[0][1] !== coordinates[coordinates.length-1][1]) {
        coordinates.push(coordinates[0]);
      }

      geofences.push({
        name: data.name,
        description: data.description,
        polygon: turf.polygon([coordinates]),
        color: data.color_code
      });
    }
  });

  cachedGeofences = geofences;
  lastCacheTime = now;
  console.log(`📦 Cached ${geofences.length} active geofences`);
  return geofences;
}

// ==================== GEOFENCE CROSSING TRACKER ====================
const geofenceCrossings = {}; 
const CROSS_THRESHOLD = 3; // triggers alert after 3 crossings

// ==================== MQTT MESSAGE HANDLER ====================
client.on('message', async (topic, message) => {
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

    // ✅ Update RTDB latest GPS
    await rtdb.ref(`gpsData/${bikeId}/latest`).set(gpsData);

    // ---------- CHECK AGAINST ALL ACTIVE GEOFENCES ----------
    const point = turf.point([data.longitude, data.latitude]);
    const geofences = await getActiveGeofences();
    let insideAny = false;

    for (const gf of geofences) {
      if (turf.booleanPointInPolygon(point, gf.polygon)) {
        insideAny = true;
        console.log(`🚲 Bike ${bikeId} is inside geofence: ${gf.name}`);
        break;
      }
    }

    // ---------- GEOFENCE CROSSING ALERT ----------
    if (!insideAny) {
      console.log(`🚨 Bike ${bikeId} is OUTSIDE all geofences!`);
      client.publish(
        `esp32/cmd/${bikeId}`,
        JSON.stringify({ command: 'alert', reason: 'out_of_bounds' })
      );

      if (!geofenceCrossings[bikeId]) geofenceCrossings[bikeId] = 0;
      geofenceCrossings[bikeId] += 1;
      console.log(`⚠️ Bike ${bikeId} geofence crossing count: ${geofenceCrossings[bikeId]}`);

      if (geofenceCrossings[bikeId] >= CROSS_THRESHOLD) {
        await firestore.collection("alerts").add({
          bikeId,
          type: "geofence_cross",
          message: `Bike ${bikeId} crossed geofence`,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          count: geofenceCrossings[bikeId],
          resolved: false,
        });
        console.log(`🚨 Alert logged for bike ${bikeId}`);
        geofenceCrossings[bikeId] = 0; // reset after alert
      }
    } else {
      // reset counter if bike is inside
      geofenceCrossings[bikeId] = 0;
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

  try {
    const tokenRef = firestore.collection("bikes").doc(bikeId)
      .collection("tokens").doc(token);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) return res.status(400).send("Invalid token.");
    const tokenData = tokenSnap.data();
    if (tokenData.used) return res.status(400).send("Token already used.");
    if (Date.now() > tokenData.expiresAt) return res.status(400).send("Token expired.");

    await tokenRef.update({ used: true });

    const paymentRef = await firestore.collection("payments").add({
      uid: userId,
      paymentAccount: "miggy account",
      paymentType: "gcash",
      paymentStatus: "successful",
      amount,
      paymentDate: admin.firestore.FieldValue.serverTimestamp(),
      isDeleted: false,
      deletedAt: null
    });

    const paymentId = paymentRef.id;

    const rideRef = await firestore.collection("ride_logs").add({
      bikeId,
      userId,
      paymentId,
      startTime: admin.firestore.FieldValue.serverTimestamp(),
      endTime: null,
      points: [],
      isDeleted: false,
      deletedAt: null
    });

    const rideId = rideRef.id;

    await firestore.collection("bikes").doc(bikeId).update({
      status: "paid",
      isActive: true,
      rentedBy: userId,
      activeRideId: rideId,
    });

    const blinkPayload = {
      command: "blink",
      qrCode,
      userId,
      rideTime
    };
    client.publish(`esp32/cmd/${bikeId}`, JSON.stringify(blinkPayload));

    console.log(`⬇️ Ride started for ${bikeId}, rideId: ${rideId}, paymentId: ${paymentId}, amount: ${amount}, rideTime: ${rideTime}`);

    const redirectUrl = `myapp://main?payment_status=success&bikeId=${bikeId}&rideId=${rideId}&userId=${userId}`;
    res.redirect(redirectUrl);

  } catch (err) {
    console.error("❌ /success error:", err);
    res.status(500).send("Internal server error.");
  }
});

// ---------- Soft Delete Ride ----------
app.post("/deleteRide", async (req, res) => {
  const { rideId, userId } = req.body;
  if (!rideId || !userId) return res.status(400).json({ error: "Missing rideId or userId" });

  try {
    const rideRef = firestore.collection("ride_logs").doc(rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: "Ride not found" });

    const rideData = rideSnap.data();
    if (rideData.userId !== userId) return res.status(403).json({ error: "Not authorized to delete this ride" });

    await rideRef.update({
      isDeleted: true,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (rideData.paymentId) {
      const paymentRef = firestore.collection("payments").doc(rideData.paymentId);
      await paymentRef.update({
        isDeleted: true,
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`💰 Payment ${rideData.paymentId} also soft-deleted`);
    }

    console.log(`🗑️ Ride ${rideId} soft-deleted by user ${userId}`);
    res.json({ success: true, message: "Ride and payment soft-deleted successfully." });

  } catch (err) {
    console.error("❌ /deleteRide error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- End ride ----------
app.post("/endRide", async (req, res) => {
  const { bikeId, qrCode, userId } = req.body;
  if (!bikeId || !userId || !qrCode) return res.status(400).json({ error: "Missing parameters" });

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
