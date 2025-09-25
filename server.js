const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, '.env') });
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const webpush = require("web-push");

const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];

/** ---------------- Web Push (VAPID) ---------------- **/
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("⚠️ VAPID keys missing. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in backend .env to enable Web Push.");
}

webpush.setVapidDetails(
  "mailto:admin@example.com",
  VAPID_PUBLIC_KEY || "public-key-not-set",
  VAPID_PRIVATE_KEY || "private-key-not-set"
);
/** --------------------------------------------------- **/

const app = express();
app.use(express.json());
app.use(cors({ origin: allowedOrigins }));
app.use("/api", require("./routes"));

const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("❌ MONGO_URI is missing. Check your .env file!");
    process.exit(1);
}

mongoose.connect(mongoURI)
.then(() => console.log("✅ MongoDB Connected Successfully"))
.catch(err => console.error("❌ MongoDB connection error:", err));

mongoose.connection.on("disconnected", () => {
    console.warn("⚠️ MongoDB Disconnected. Attempting Reconnect...");
    mongoose.connect(mongoURI).catch(err => console.error("❌ MongoDB reconnection failed:", err));
});

const server = http.createServer(app);
const io = new Server(server, {
    // Use a unique path for the app socket so it doesn't collide with WDS HMR
    path: "/socketio",
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"]
    }
});
console.log("✅ Socket.IO mounted", { path: "/socketio", allowedOrigins });

app.set("io", io);

/** ---------------- Web Push helpers & routes ---------------- **/
async function sendPushToAll(payload) {
  console.log("[push] sendPushToAll called with payload:", {
    title: payload?.title,
    tag: payload?.tag,
    hasData: !!payload?.data
  });
  // Disabled if keys are not set
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subs = await PushSubscription.find({}).lean();
  console.log("[push] subscriptions found:", subs.length);
  let _ok = 0, _fail = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload)
        );
        _ok++;
      } catch (err) {
        _fail++;
        // Clean-up stale/invalid subscriptions
        if (err && (err.statusCode === 410 || err.statusCode === 404)) {
          await PushSubscription.deleteOne({ endpoint: sub.endpoint });
        } else {
          console.error("Push send error:", err?.statusCode, err?.body || err?.message);
        }
      }
    })
  );
  console.log("[push] send complete:", { success: _ok, failed: _fail });
}

app.set("sendPush", sendPushToAll);

// Expose public VAPID key to frontend
app.get("/api/push/public-key", (_req, res) => {
  console.log("[push] GET /api/push/public-key -> hasKey:", !!VAPID_PUBLIC_KEY);
  res.json({ publicKey: VAPID_PUBLIC_KEY || "" });
});

// Save (or upsert) a subscription from the client
app.post("/api/push/subscribe", async (req, res) => {
  try {
    const { subscription, username } = req.body || {};
    console.log("[push] POST /api/push/subscribe from user:", username, "endpoint:", subscription && subscription.endpoint);
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ message: "Invalid subscription" });
    }

    await PushSubscription.updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: {
          keys: subscription.keys,
          username: username || null
        }
      },
      { upsert: true }
    );
    console.log("[push] subscription saved OK for:", subscription.endpoint);

    res.json({ ok: true });
  } catch (e) {
    console.error("[push] subscribe error:", e?.statusCode || "", e?.message || e);
    res.status(500).json({ message: "Failed to save subscription" });
  }
});
/** ----------------------------------------------------------- **/

process.on("SIGINT", async () => {
    console.log("🔴 Closing Mongoose Connection...");
    await mongoose.connection.close();
    process.exit(0);
});

const CleaningLog = require("./models/CleaningLog");
const RoomDND = require("./models/RoomDND");
const RoomPriority = require("./models/RoomPriority");
const InspectionLog = require("./models/InspectionLog");
const RoomNote = require("./models/RoomNote");

/** ---- Push Subscription model (minimal) ---- **/
const SubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: String,
    auth: String
  },
  username: String,
  createdAt: { type: Date, default: Date.now }
});
const PushSubscription = mongoose.models.PushSubscription || mongoose.model("PushSubscription", SubscriptionSchema);
/** ------------------------------------------- **/

const allRoomNumbers = [
    "001", "002", "003", "004", "005", "006", "007",
    "011", "012", "013", "014", "015", "016", "017",
    "101", "102", "103", "104", "105", "106", "107", "108", "109", "110",
    "111", "112", "113", "114", "115", "116", "117",
    "201", "202", "203", "204", "205", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217"
];

io.on('connection', (socket) => {
    console.log('A user connected via WebSocket');

    socket.on('requestInitialData', async () => {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            // Fetch existing logs for today
            const existingLogs = await CleaningLog.find({ date: { $gte: today, $lt: tomorrow } });
            const existingRoomNumbers = new Set(existingLogs.map(log => String(log.roomNumber).padStart(3, "0")));

            // Identify missing rooms
            const missingRoomNumbers = allRoomNumbers.filter(room => !existingRoomNumbers.has(room));

            // Create logs for missing rooms
            if (missingRoomNumbers.length > 0) {
                const newLogs = missingRoomNumbers.map(roomNumber => ({ 
                    roomNumber: parseInt(roomNumber, 10),
                    date: today
                }));
                await CleaningLog.insertMany(newLogs);
            }

            // Fetch all logs for today (including newly created ones)
            const cleaningLogs = await CleaningLog.find({ date: { $gte: today, $lt: tomorrow } });
            const cleaningStatus = {};
            cleaningLogs.forEach(log => {
                const roomStr = String(log.roomNumber).padStart(3, "0");
                if (log.checkedTime) {
                    cleaningStatus[roomStr] = "checked";
                } else if (log.finishTime) {
                    cleaningStatus[roomStr] = "finished";
                } else if (log.startTime) {
                    cleaningStatus[roomStr] = "in_progress";
                } else {
                    cleaningStatus[roomStr] = "not_started";
                }
            });

            // Fetch DND statuses for today
            const dndLogs = await RoomDND.find({ dndSetAt: { $gte: today, $lt: tomorrow } }, "roomNumber dndStatus").lean();
            const dndStatus = {};
            dndLogs.forEach(dnd => {
                dndStatus[String(dnd.roomNumber).padStart(3, "0")] = dnd.dndStatus ? "dnd" : "available";
            });

            // Fetch priorities
            const priorityLogs = await RoomPriority.find({}, "roomNumber priority").lean();
            const priorities = {};
            priorityLogs.forEach(p => {
                priorities[String(p.roomNumber).padStart(3, "0")] = p.priority;
            });

            // Fetch inspection logs for today
            const inspectionLogs = await InspectionLog.find({ date: { $gte: today, $lt: tomorrow } });

            // Fetch all room notes for today
            const roomNoteLogs = await RoomNote.find({ createdAt: { $gte: today, $lt: tomorrow } });
            const roomNotes = {};
            roomNoteLogs.forEach(note => {
                roomNotes[String(note.roomNumber).padStart(3, "0")] = note;
            });

            socket.emit('initialData', {
                cleaningStatus,
                dndStatus,
                priorities,
                inspectionLogs,
                roomNotes
            });
        } catch (error) {
            console.error('Error fetching initial data for WebSocket client:', error);
            socket.emit('initialDataError', { message: 'Failed to fetch initial data.' });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected from WebSocket');
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});