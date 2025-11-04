// server.js (ESM version) - SMS FUNCTIONS COMMENTED OUT + BIKE HEARTBEAT CHECKER
import mqtt from "mqtt";
import admin from "firebase-admin";
import express from "express";
import crypto from "crypto";
import * as turf from "@turf/turf";
import fs from "fs";
import fetch from "node-fetch";

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

// ==================== EXPRESS INIT (MUST BE EARLY) ====================
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

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
  client.subscribe("esp32/alerts", (err) => {
    if (!err) console.log("📡 Subscribed to esp32/alerts");
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

  const geofenceSnap = await firestore
    .collection("geofence")
    .where("is_active", "==", true)
    .get();

  const geofences = [];

  geofenceSnap.forEach((doc) => {
    const data = doc.data();
    if (data.points && data.points.length) {
      const coordinates = data.points.map((p) => [
        p.location.longitude,
        p.location.latitude,
      ]);

      // close the polygon if not closed
      if (
        coordinates[0][0] !== coordinates[coordinates.length - 1][0] ||
        coordinates[0][1] !== coordinates[coordinates.length - 1][1]
      ) {
        coordinates.push(coordinates[0]);
      }

      geofences.push({
        name: data.name,
        description: data.description,
        polygon: turf.polygon([coordinates]),
        color: data.color_code,
      });
    }
  });

  cachedGeofences = geofences;
  lastCacheTime = now;
  console.log(`📦 Cached ${geofences.length} active geofences`);
  return geofences;
}

// ==================== GEOFENCE CROSSING TRACKER WITH COOLDOWN ====================
const geofenceCrossings = {};

// ==================== MOVEMENT/CRASH ALERT TRACKER WITH COOLDOWN ====================
const movementAlerts = {};
const CRASH_ALERT_COOLDOWN = 2 * 60 * 1000; // 2 minutes
const alertProcessingLocks = {}; // Prevent race conditions

// ==================== PHILSMS CONFIG ====================
const PHILSMS_API_TOKEN = "3186|RQCCqdWxPG9SuGOrqPvBdDoFIfeOmw0WqVDev9Vg";
const PHILSMS_SENDER_ID = "PhilSMS";

// ==================== BIKE HEARTBEAT TRACKER ====================
const bikeLastSeen = {};
const OFFLINE_TIMEOUT = 10 * 1000; // 10 seconds


async function sendSMSAlert(bikeId, alertType = "geofence_cross") {
  const randomTag = Math.floor(Math.random() * 1000);

  let MESSAGE;
  if (alertType === "movement") {
    MESSAGE = `Dude your bike ${bikeId} moved while parked, better check out the admin page. Ref#${randomTag}`;
  } else if (alertType === "crash") {
    MESSAGE = `#SikadAlert: Bike ${bikeId} crash detected while on ride! Ref#${randomTag}`;
  } else {
    MESSAGE = `#SikadAlert: Bike ${bikeId} exited geofence (Ref: ${randomTag})`;
  }

  try {
    const adminSnap = await firestore.collection("admin_accounts").get();
    const recipients = adminSnap.docs
      .map((doc) => doc.data().Number)
      .filter((num) => !!num);

    if (recipients.length === 0) {
      console.log("⚠️ No admin phone numbers found in admin_accounts.");
      return;
    }

    console.log(`📱 Sending ${alertType} alert to ${recipients.length} admin(s):`, recipients);

    const sendPromises = recipients.map(async (TO_NUMBER) => {
      try {
        const response = await fetch("https://app.philsms.com/api/v3/sms/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PHILSMS_API_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            recipient: TO_NUMBER,
            sender_id: PHILSMS_SENDER_ID,
            type: "plain",
            message: MESSAGE,
          }),
        });

        const text = await response.text();
        let result;
        try {
          result = JSON.parse(text);
        } catch {
          result = { status: "error", message: "Invalid JSON", raw: text };
        }

        // Retry once if "Telco Issues"
        if (result.message && result.message.includes("Telco Issues")) {
          console.log(`⚠️ Telco issue for ${TO_NUMBER}. Retrying in 5s...`);
          await new Promise((res) => setTimeout(res, 5000));

          const retryResponse = await fetch("https://app.philsms.com/api/v3/sms/send", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${PHILSMS_API_TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              recipient: TO_NUMBER,
              sender_id: PHILSMS_SENDER_ID,
              type: "plain",
              message: MESSAGE,
            }),
          });
          const retryResult = await retryResponse.json();
          return { TO_NUMBER, result: retryResult };
        }

        return { TO_NUMBER, result };
      } catch (err) {
        return { TO_NUMBER, error: err.message };
      }
    });

    const results = await Promise.allSettled(sendPromises);

    results.forEach((r) => {
      if (r.status === "fulfilled") {
        const { TO_NUMBER, result, error } = r.value;
        if (error) {
          console.log(`❌ SMS failed for ${TO_NUMBER}:`, error);
        } else if (result.status === "success") {
          console.log(`✅ SMS sent to ${TO_NUMBER}`);
        } else {
          console.log(`⚠️ SMS error for ${TO_NUMBER}:`, result);
        }
      } else {
        console.log("❌ SMS Promise rejected:", r.reason);
      }
    });
  } catch (error) {
    console.error("❌ Error sending SMS alert:", error);
  }
}


// ==================== SINGLE MQTT MESSAGE HANDLER ====================
client.on("message", async (topic, message) => {
  try {
    const msg = message.toString();
    console.log(`📨 Received on ${topic}: ${msg}`);

    // ===== HANDLE GPS LOCATION UPDATES =====
    if (topic.startsWith("esp32/gps/")) {
      const bikeId = topic.split("/")[2];

      try {
        const data = JSON.parse(msg);

        if (!data.latitude || !data.longitude) {
          console.log(`⚠️ Invalid GPS data for ${bikeId}:`, data);
          return;
        }

        console.log(`🌍 GPS Update - Bike ${bikeId}: [${data.latitude}, ${data.longitude}] Speed: ${data.speed || 0}`);

        // ===== Record heartbeat =====
        bikeLastSeen[bikeId] = Date.now();

        // // Immediately mark as available
        // await firestore.collection("bikes").doc(bikeId).update({
        //   status: "AVAILABLE",
        //   updated_at: admin.firestore.FieldValue.serverTimestamp(),
        // });
        // await rtdb.ref(`bikes/${bikeId}`).update({
        //   status: "AVAILABLE",
        //   last_update: admin.database.ServerValue.TIMESTAMP,
        // });

        // ===== 1. UPDATE FIREBASE RTDB =====
        await rtdb.ref(`bikes/${bikeId}`).update({
          latitude: data.latitude,
          longitude: data.longitude,
          speed: data.speed || 0,
          bike_model: data.bike_model || "Unknown",
          bike_type: data.bike_type || "REGULAR",
          status: data.status || "AVAILABLE",
          current_zone_id: data.current_zone_id || "",
          last_update: admin.database.ServerValue.TIMESTAMP,
        });

        console.log(`✅ RTDB updated for ${bikeId}`);

        // ===== 2. UPDATE FIRESTORE =====
        const bikeRef = firestore.collection("bikes").doc(bikeId);
        await bikeRef.set(
          {
            current_location: new admin.firestore.GeoPoint(
              data.latitude,
              data.longitude
            ),
            status: data.status || "AVAILABLE",
            bike_model: data.bike_model || "Unknown",
            bike_type: data.bike_type || "REGULAR",
            current_zone_id: data.current_zone_id || "",
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // ===== 3. ADD TO LOCATION HISTORY =====
        await bikeRef.collection("location_history").add({
          location: new admin.firestore.GeoPoint(data.latitude, data.longitude),
          speed: data.speed || 0,
          recorded_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`📍 Location history saved for ${bikeId}`);

        const bikeDoc = await firestore.collection("bikes").doc(bikeId).get();
        const bikeData = bikeDoc.data();

        if (bikeData?.isActive && bikeData?.rentedBy && bikeData?.activeRideId) {
          const rideId = bikeData.activeRideId;
          const rideRef = firestore.collection("ride_logs").doc(rideId);

          await rideRef.update({
            points: admin.firestore.FieldValue.arrayUnion({
              latitude: data.latitude,
              longitude: data.longitude,
              speed: data.speed || 0,
              timestamp: new Date().toISOString(),
            }),
          });

          console.log(`🗺️ Point added to ride log ${rideId} for bike ${bikeId}`);
        }

        // ===== 4. CHECK GEOFENCE VIOLATIONS =====
        const point = turf.point([data.longitude, data.latitude]);
        const geofences = await getActiveGeofences();
        let insideAny = false;

        for (const gf of geofences) {
          if (turf.booleanPointInPolygon(point, gf.polygon)) {
            insideAny = true;
            console.log(`✅ Bike ${bikeId} inside geofence: ${gf.name}`);
            break;
          }
        }

        const now = Date.now();

        if (!geofenceCrossings[bikeId]) {
          geofenceCrossings[bikeId] = {
            lastSMSSentAt: 0,
            alertActive: false,
            insideCount: 0,
            cooldown: 5 * 60 * 1000,
          };
        }

        const alertState = geofenceCrossings[bikeId];

        if (!insideAny) {
          console.log(`🚨 Bike ${bikeId} is OUTSIDE all geofences!`);
          client.publish(
            `esp32/cmd/${bikeId}`,
            JSON.stringify({ command: "alert", reason: "out_of_bounds" })
          );

          const timeSinceLastSMS = now - alertState.lastSMSSentAt;

          if (!alertState.alertActive && timeSinceLastSMS > alertState.cooldown) {
          console.log(`📤 (TEST MODE) Geofence alert triggered for ${bikeId}`);

          // ✅ Start cooldown immediately before sending SMS
          alertState.lastSMSSentAt = now;
          alertState.alertActive = true;
          alertState.cooldown = 5 * 60 * 1000;
          alertState.insideCount = 0;

          const bikeSnap = await firestore.collection("bikes").doc(bikeId).get();
          const bikeData = bikeSnap.exists ? bikeSnap.data() : {};

          await firestore.collection("alerts").add({
            bikeId,
            type: "geofence_cross",
            message: `Bike ${bikeId} exited geofence`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),

            // ✅ Extra fields
            rentalId: bikeData?.activeRideId || null,
            zoneId: bikeData?.current_zone_id || null,
            lastLat: data.latitude || bikeData?.current_location?.latitude || null,
            lastLong: data.longitude || bikeData?.current_location?.longitude || null,
          });


          await firestore.collection("geofence_violations").add({
            bike_id: bikeId,
            location: new admin.firestore.GeoPoint(data.latitude, data.longitude),
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            violation_type: "GEOFENCE_EXIT",
          });

          await sendSMSAlert(bikeId, "geofence_cross");

          console.log(`⏱️ Cooldown initiated for ${bikeId}: 5 minutes`);
        }

        } else {
          if (alertState.alertActive) {
            alertState.insideCount++;
            if (alertState.insideCount >= 3) {
              alertState.alertActive = false;
              alertState.cooldown = 60 * 1000;
              console.log(`✅ Bike ${bikeId} safely back inside geofence.`);
            }
          }
        }

        geofenceCrossings[bikeId] = alertState;
      } catch (parseError) {
        console.error(`❌ Error parsing GPS data for ${bikeId}:`, parseError);
      }
    }

    // ===== HANDLE MOVEMENT/CRASH ALERTS =====
if (topic === "esp32/alerts") {
  try {
    const data = JSON.parse(msg);
    const { bikeId, type } = data;

    if (!["movement", "crash"].includes(type)) {
      console.log(`⚠️ Unknown alert type: ${type}`);
      return;
    }

    if (!movementAlerts[bikeId]) {
      movementAlerts[bikeId] = { lastSent: 0 };
    }

    const now = Date.now();
    const timeSinceLast = now - movementAlerts[bikeId].lastSent;

    // 🔒 Skip if still within cooldown
    if (timeSinceLast < CRASH_ALERT_COOLDOWN) {
      console.log(`⏳ ${type} alert for ${bikeId} ignored (cooldown)`);
      return;
    }

    // 🔒 Prevent concurrent processing
    if (alertProcessingLocks[bikeId]) {
      console.log(`🔒 ${type} alert ignored (already processing)`);
      return;
    }

    // ✅ START COOLDOWN IMMEDIATELY upon receiving alert
    alertProcessingLocks[bikeId] = true;
    movementAlerts[bikeId].lastSent = now;

    console.log(`🚨 Processing ${type} alert from bike ${bikeId}`);

    // Update bike status in RTDB
    await rtdb.ref(`bikes/${bikeId}`).update({
      status: type === "crash" ? "OFFLINE" : "MAINTENANCE",
      last_alert: type,
      last_alert_time: admin.database.ServerValue.TIMESTAMP,
    });

    // Retrieve bike data to get active ride, zone, and last location
    const bikeSnap = await firestore.collection("bikes").doc(bikeId).get();
    const bikeData = bikeSnap.exists ? bikeSnap.data() : {};

    await firestore.collection("alerts").add({
      bikeId,
      type,
      message:
        data.message ||
        (type === "movement"
          ? `Movement detected while locked for bike ${bikeId}`
          : `Crash detected while bike ${bikeId} was on ride`),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      resolved: false,

      // ✅ Extra fields
      rentalId: bikeData?.activeRideId || null,
      zoneId: bikeData?.current_zone_id || null,
      lastLat: data.latitude || bikeData?.current_location?.latitude || null,
      lastLong: data.longitude || bikeData?.current_location?.longitude || null,
    });

    // 📨 Send SMS (or test mode)
    await sendSMSAlert(bikeId, type);

    console.log(`📤 (TEST MODE) ${type} alert logged for ${bikeId}`);

    // Release processing lock after 1s
    setTimeout(() => {
      alertProcessingLocks[bikeId] = false;
    }, 1000);
  } catch (alertError) {
    console.error("❌ Error processing alert:", alertError);
  }
}

  } catch (error) {
    console.error("❌ Error handling MQTT message:", error);
  }
});

// ==================== BIKE OFFLINE MONITOR ====================
async function checkBikeStatus() {
  const now = Date.now();

  for (const [bikeId, lastSeen] of Object.entries(bikeLastSeen)) {
    if (now - lastSeen > OFFLINE_TIMEOUT) {
      console.log(`⚠️ Bike ${bikeId} is OFFLINE (no GPS in ${OFFLINE_TIMEOUT / 1000}s)`);

      try {
        await firestore.collection("bikes").doc(bikeId).update({
          status: "OFFLINE",
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        await rtdb.ref(`bikes/${bikeId}`).update({
          status: "OFFLINE",
          last_update: admin.database.ServerValue.TIMESTAMP,
        });
      } catch (err) {
        console.error(`❌ Failed to update offline status for ${bikeId}:`, err);
      }

      delete bikeLastSeen[bikeId];
    }
  }
}
setInterval(checkBikeStatus, 5000);

// ==================== EXPRESS API ENDPOINTS ====================

// Health check
app.get("/", (req, res) => {
  res.send("✅ Node.js MQTT server is running (SMS disabled).");
});

// Token generator
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}


app.get("/generate-token", async (req, res) => {
  const { bikeId, qrCode } = req.query;
  if (!bikeId || !qrCode) {
    return res.status(400).json({ error: "Missing bikeId or qrCode" });
  }

  const token = generateToken();
  const expiresAt = Date.now() + 5 * 60 * 1000;

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


// Payment success endpoint
app.get("/success", async (req, res) => {
  const { bikeId, qrCode, token, userId, rideTime, amount } = req.query;
  if (!bikeId || !qrCode || !token || !userId || !amount) {
    return res.status(400).send("Missing parameters.");
  }

  try {
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

    const paymentRef = await firestore.collection("payments").add({
      uid: userId,
      paymentAccount: "miggy account",
      paymentType: "gcash",
      paymentStatus: "successful",
      amount,
      paymentDate: admin.firestore.FieldValue.serverTimestamp(),
      isDeleted: false,
      deletedAt: null,
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
      deletedAt: null,
    });

    const rideId = rideRef.id;

    await firestore.collection("bikes").doc(bikeId).update({
      status: "IN_RENT",
      isActive: true,
      rentedBy: userId,
      activeRideId: rideId,
    });

    const blinkPayload = {
      command: "blink",
      qrCode,
      userId,
      rideTime,
    };
    client.publish(`esp32/cmd/${bikeId}`, JSON.stringify(blinkPayload));

    console.log(
      `⬇️ Ride started for ${bikeId}, rideId: ${rideId}, paymentId: ${paymentId}, amount: ${amount}, rideTime: ${rideTime}`
    );

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
  if (!rideId || !userId) {
    return res.status(400).json({ error: "Missing rideId or userId" });
  }

  try {
    const rideRef = firestore.collection("ride_logs").doc(rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) {
      return res.status(404).json({ error: "Ride not found" });
    }

    const rideData = rideSnap.data();
    if (rideData.userId !== userId) {
      return res.status(403).json({ error: "Not authorized to delete this ride" });
    }

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
  if (!bikeId || !userId || !qrCode) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const bikeRef = firestore.collection("bikes").doc(bikeId);
    const bikeSnap = await bikeRef.get();
    if (!bikeSnap.exists) {
      return res.status(404).json({ error: "Bike not found" });
    }

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
  if (!bikeId) {
    return res.status(400).json({ error: "Missing bikeId" });
  }

  try {
    client.publish(`esp32/cmd/${bikeId}`, JSON.stringify({ command: "lock" }));
    console.log(`🔒 Sent LOCK to bike ${bikeId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /lockBike failed", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLEANUP FUNCTION ====================
async function cleanupInactiveBikes() {
  try {
    const snapshot = await rtdb.ref("bikes").once("value");
    const now = Date.now();
    const INACTIVE_THRESHOLD = 24 * 60 * 60 * 1000;

    snapshot.forEach((childSnapshot) => {
      const bikeData = childSnapshot.val();
      const lastUpdate = bikeData.last_update || 0;

      if (now - lastUpdate > INACTIVE_THRESHOLD) {
        console.log(`🗑️ Removing inactive bike: ${childSnapshot.key}`);
        rtdb.ref(`bikes/${childSnapshot.key}`).remove();
      }
    });
  } catch (error) {
    console.error("Error cleaning up bikes:", error);
  }
}

setInterval(cleanupInactiveBikes, 60 * 60 * 1000);

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔍 API: http://localhost:${PORT}`);
  console.log(`🗺️  Bikes API: http://localhost:${PORT}/api/bikes`);
});
