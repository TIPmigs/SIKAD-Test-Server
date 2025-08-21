// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // needed if pushing to Firebase

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Example Firebase Realtime Database endpoint
const FIREBASE_URL = "https://your-project-id.firebaseio.com/gps.json";

// In-memory log (just for quick testing)
let gpsLogs = [];

// Endpoint to receive GPS data
app.post("/gps", async (req, res) => {
  const { latitude, longitude } = req.body;

  if (!latitude || !longitude) {
    return res.status(400).json({ error: "Invalid GPS data" });
  }

  // Store locally
  const entry = {
    latitude,
    longitude,
    timestamp: new Date().toISOString(),
  };
  gpsLogs.push(entry);

  console.log("Received GPS:", entry);

  // Optional: Forward to Firebase Realtime DB
  try {
    await fetch(FIREBASE_URL, {
      method: "POST",
      body: JSON.stringify(entry),
      headers: { "Content-Type": "application/json" },
    });
    console.log("Forwarded to Firebase");
  } catch (err) {
    console.error("Firebase error:", err.message);
  }

  res.json({ status: "OK", saved: entry });
});

// Health check
app.get("/", (req, res) => {
  res.send("GPS Server is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
