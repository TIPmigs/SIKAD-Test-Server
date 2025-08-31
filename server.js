// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // for forwarding to Firebase

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ Firebase Realtime DB endpoint (fixed)
const FIREBASE_URL = "https://cit306-finalproject-default-rtdb.firebaseio.com/gps.json";

// In-memory log (useful for testing before DB integration)
let gpsLogs = [];

// 📡 Endpoint to receive GPS data from SIM800L
app.post("/gps", async (req, res) => {
  const { latitude, longitude } = req.body;

  if (!latitude || !longitude) {
    console.log("❌ Bad data received:", req.body); // <-- helpful debug log
    return res.status(400).json({ error: "Invalid GPS data" });
  }

  // Save entry locally
  const entry = {
    latitude,
    longitude,
    timestamp: new Date().toISOString(),
  };
  gpsLogs.push(entry);

  console.log("✅ Received GPS:", entry);

  // 🔄 Forward to Firebase
  try {
    const firebaseRes = await fetch(FIREBASE_URL, {
      method: "POST",
      body: JSON.stringify(entry),
      headers: { "Content-Type": "application/json" },
    });

    if (!firebaseRes.ok) {
      throw new Error(`Firebase responded with ${firebaseRes.status}`);
    }

    console.log("☁️ Forwarded to Firebase successfully");
  } catch (err) {
    console.error("❌ Firebase error:", err.message);
  }

  // Respond to IoT device
  res.json({ status: "OK", saved: entry });
});

// ✅ Health check (useful for testing ngrok link)
app.get("/", (req, res) => {
  res.send("🌍 GPS Server is running and ready to receive data!");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🌐 Public URL via ngrok: https://57a760df7eb7.ngrok-free.app`);
});
