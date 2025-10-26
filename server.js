const path = require("path");
// Load .env only for local/dev. On Railway, runtime env vars are already injected.
if (!process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== 'production') {
  require("dotenv").config({ path: path.resolve(__dirname, '.env') });
}
const express = require("express");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const webpush = require("web-push");
const cron = require("node-cron");
const os = require("os");

const allowedOriginsList = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
// If no CORS_ORIGINS provided, allow all (helpful for first-time deploys / wake pings)
const corsOriginConfig = allowedOriginsList.length > 0 ? allowedOriginsList : true;

// Log CORS configuration at startup
console.log('[cors] configured origins:', corsOriginConfig === true ? '* (all)' : allowedOriginsList);

/** ---------------- Web Push (VAPID) ---------------- **/
const sanitizeKey = (k) => (k || "").trim().replace(/\s+/g, "");

const PUSH_SUBJECT = (process.env.PUSH_SUBJECT || 'mailto:admin@localhost').trim();
const VAPID_PUBLIC_KEY = sanitizeKey(process.env.VAPID_PUBLIC_KEY);
const VAPID_PRIVATE_KEY = sanitizeKey(process.env.VAPID_PRIVATE_KEY);

function byteLenBase64Url(s) {
  if (!s) return 0;
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  try { return Buffer.from(b64, 'base64').length; } catch { return -1; }
}

let pushEnabled = false;
(() => {
  const hasPub = !!VAPID_PUBLIC_KEY;
  const hasPriv = !!VAPID_PRIVATE_KEY;
  console.log('[push] env presence', { hasPub, hasPriv, subject: !!PUSH_SUBJECT });
  if (!hasPub || !hasPriv) {
    console.warn('⚠️ Web Push disabled: missing VAPID env.', { hasPub, hasPriv, hasSubject: !!PUSH_SUBJECT });
    return;
  }
  const pubBytes = byteLenBase64Url(VAPID_PUBLIC_KEY);
  const privBytes = byteLenBase64Url(VAPID_PRIVATE_KEY);
  if (pubBytes !== 65 || privBytes <= 0) {
    console.error('❌ Web Push disabled: invalid VAPID key lengths.', { pubBytes, privBytes });
    return;
  }
  try {
    webpush.setVapidDetails(PUSH_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushEnabled = true;
    console.log('✅ Web Push enabled. (publicKey bytes:', pubBytes, ')');
  } catch (e) {
    console.error('❌ setVapidDetails failed. Web Push disabled.', e.message);
  }
})();
/** --------------------------------------------------- **/

const app = express();
// Body parsers (must be registered BEFORE any routes)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Unified CORS (Express + Socket.IO) — allow only configured origins (or all if none configured)
const corsOptions = {
  origin: (origin, cb) => {
    // Allow non-browser or same-origin requests with no Origin header
    if (!origin) return cb(null, true);
    if (corsOriginConfig === true) return cb(null, true); // allow all if no CORS_ORIGINS set
    if (Array.isArray(allowedOriginsList) && allowedOriginsList.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: Origin not allowed -> ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204,
  maxAge: 86400 // cache preflight for 24h
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use("/api", require("./routes"));

// Fast wake endpoint for autosleep
app.get('/api/ping', (_req, res) => {
  lastActive = Date.now(); // bump activity so idle timer resets
  res.status(200).json({ ok: true, ts: Date.now() });
});

const mongoURI = process.env.MONGO_URI;

console.log("[env] diag", {
  hasMongo: !!process.env.MONGO_URI,
  hasVapidPub: !!process.env.VAPID_PUBLIC_KEY,
  hasVapidPriv: !!process.env.VAPID_PRIVATE_KEY,
  hasSubject: !!process.env.PUSH_SUBJECT,
  nodeEnv: process.env.NODE_ENV || 'undefined',
  railway: !!process.env.RAILWAY_ENVIRONMENT
});

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
      origin: corsOriginConfig,           // [] or true
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      credentials: true
    },
    // Sleep-friendly Socket.IO settings
    transports: ["websocket"],     // prefer pure websocket to reduce polling overhead
    pingInterval: 60000,            // default ~25s → 60s lowers idle CPU
    pingTimeout: 25000              // keep a reasonable timeout
});
console.log("✅ Socket.IO mounted", { path: "/socketio", allowedOrigins: corsOriginConfig });

app.set("io", io);
app.locals.pushEnabled = pushEnabled;

// --- Idle shutdown to allow Railway autosleep when unused ---
// Feature flag for idle shutdown (disabled by default)
const ENABLE_IDLE_SHUTDOWN = (process.env.SERVER_ENABLE_IDLE || 'false').toLowerCase() === 'true';
let lastActive = Date.now();
const IDLE_MS = parseInt(process.env.SERVER_IDLE_MS || '60000', 10);
if (ENABLE_IDLE_SHUTDOWN) {
  setInterval(() => {
    const clients = io.engine?.clientsCount || 0;
    const activityMarker = Math.max(lastActive, typeof graceUntil !== 'undefined' ? graceUntil : lastActive);
    if (clients === 0 && Date.now() - activityMarker > IDLE_MS) {
      console.log(`[idle] No clients for ${IDLE_MS}ms. Exiting to allow autosleep.`);
      try { server.close(() => process.exit(0)); } catch { process.exit(0); }
    }
  }, 20000).unref();
} else {
  console.log('[idle] Idle shutdown is DISABLED (SERVER_ENABLE_IDLE=false).');
}

/** ---------------- Web Push helpers & routes ---------------- **/
async function sendPushToAll(payload) {
  console.log("[push] sendPushToAll called with payload:", {
    title: payload?.title,
    tag: payload?.tag,
    hasData: !!payload?.data
  });
  if (!app.locals.pushEnabled) return;

  const subs = await PushSubscription.find({}).lean();
  console.log("[push] subscriptions found:", subs.length);
  let _ok = 0, _fail = 0;

  const BATCH = parseInt(process.env.PUSH_BATCH_SIZE || '100', 10);
  for (let i = 0; i < subs.length; i += BATCH) {
    const slice = subs.slice(i, i + BATCH);
    await Promise.all(slice.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload)
        );
        _ok++;
      } catch (err) {
        _fail++;
        if (err && (err.statusCode === 410 || err.statusCode === 404)) {
          await PushSubscription.deleteOne({ endpoint: sub.endpoint });
        } else {
          console.error("Push send error:", err?.statusCode, err?.body || err?.message);
        }
      }
    }));
    // yield briefly to avoid blocking the event loop on large sends
    await new Promise(r => setTimeout(r, 10));
  }

  console.log("[push] send complete:", { success: _ok, failed: _fail });
}

app.set("sendPush", sendPushToAll);

// Expose public VAPID key to frontend
app.get("/api/push/public-key", (_req, res) => {
  console.log("[push] GET /api/push/public-key", { pushEnabled: app.locals.pushEnabled === true, hasKey: !!VAPID_PUBLIC_KEY });
  res.json({ publicKey: VAPID_PUBLIC_KEY || "" });
});

app.get('/_debug/push', (_req, res) => {
  res.json({ pushEnabled: app.locals.pushEnabled === true });
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

// ---- Date helpers (Asia/Phnom_Penh) ----
function getTodayRange() {
  const start = moment().tz('Asia/Phnom_Penh').startOf('day');
  return { start: start.toDate(), end: start.clone().add(1, 'day').toDate() };
}

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

// ---- App-wide cache for initial data ----
let initialDataCache = null;
let cacheDate = null;

// Ensure logs for all rooms exist for the current day
async function ensureTodaysCleaningLogs() {
    try {
        const { start: today, end: tomorrow } = getTodayRange();
        const existingLogs = await CleaningLog.find({ date: { $gte: today, $lt: tomorrow } }).select('roomNumber').lean();
        const existingRoomNumbers = new Set(existingLogs.map(log => String(log.roomNumber).padStart(3, "0")));
        const missingRoomNumbers = allRoomNumbers.filter(room => !existingRoomNumbers.has(room));

        if (missingRoomNumbers.length > 0) {
            console.log(`[daily] creating ${missingRoomNumbers.length} missing cleaning logs for today`);
            const newLogs = missingRoomNumbers.map(roomNumber => ({
                roomNumber: parseInt(roomNumber, 10),
                date: today
            }));
            await CleaningLog.insertMany(newLogs);
            return true; // Logs were created
        }
    } catch (error) {
        console.error('Error ensuring daily cleaning logs:', error);
    }
    return false; // No logs created
}

// Fetch and cache all the necessary initial data
async function getOrCacheInitialData() {
    const todayStr = moment().tz('Asia/Phnom_Penh').format('YYYY-MM-DD');
    if (initialDataCache && cacheDate === todayStr) {
        console.log('[cache] returning cached initial data');
        return initialDataCache;
    }

    console.log('[cache] miss. fetching new initial data for', todayStr);
    const { start: today, end: tomorrow } = getTodayRange();

    // Queries to run in parallel
    const queries = {
        cleaningLogs: CleaningLog.find({ date: { $gte: today, $lt: tomorrow } }).lean(),
        dndLogs: RoomDND.find({ date: { $gte: today, $lt: tomorrow } }, "roomNumber dndStatus").lean(),
        priorityLogs: RoomPriority.find({}, "roomNumber priority").lean(),
        inspectionLogs: InspectionLog.find({ date: { $gte: today, $lt: tomorrow } }).lean(),
        roomNoteLogs: RoomNote.find({ updatedAt: { $gte: today, $lt: tomorrow } }).lean()
    };

    const results = await Promise.all(Object.values(queries));
    const [cleaningLogs, dndLogs, priorityLogs, inspectionDocs, roomNoteLogs] = results;

    // Process cleaning logs
    const cleaningStatus = {};
    cleaningLogs.forEach(log => {
        const roomStr = String(log.roomNumber).padStart(3, "0");
        if (log.checkedTime) cleaningStatus[roomStr] = { status: "checked" };
        else if (log.finishTime) cleaningStatus[roomStr] = { status: "finished" };
        else if (log.startTime) cleaningStatus[roomStr] = { status: "in_progress", startTime: log.startTime };
        else cleaningStatus[roomStr] = { status: "not_started" };
    });

    // Process DND statuses
    const dndStatus = {};
    dndLogs.forEach(dnd => {
        dndStatus[String(dnd.roomNumber).padStart(3, "0")] = dnd.dndStatus ? "dnd" : "available";
    });

    // Process priorities
    const priorities = {};
    priorityLogs.forEach(p => {
        priorities[String(p.roomNumber).padStart(3, "0")] = p.priority;
    });

    // Process inspection logs
    const inspectionLogs = inspectionDocs.map(log => ({
        ...log,
        roomNumber: String(log.roomNumber).padStart(3, "0"),
    }));

    // Process room notes
    const roomNotes = {};
    roomNoteLogs.forEach(note => {
        roomNotes[String(note.roomNumber).padStart(3, "0")] = note;
    });

    initialDataCache = { cleaningStatus, dndStatus, priorities, inspectionLogs, roomNotes };
    cacheDate = todayStr;

    console.log('[cache] new data cached for', todayStr);
    return initialDataCache;
}

// Invalidate cache on daily reset
function invalidateCache() {
    console.log('[cache] invalidating cache');
    initialDataCache = null;
    cacheDate = null;
}

// ---- Cache helpers for mutation routes ----
const cacheHelpers = {
  invalidate: () => {
    try {
      invalidateCache();
    } catch (e) {
      console.warn('[cache] invalidate failed', e?.message || e);
    }
  },
  upsertCleaningStatus: ({ roomNumber, status, startTime }) => {
    try {
      if (!initialDataCache) return; // nothing cached yet
      const roomStr = String(roomNumber).padStart(3, '0');
      initialDataCache.cleaningStatus = initialDataCache.cleaningStatus || {};

      if (status === 'in_progress' && startTime) {
        initialDataCache.cleaningStatus[roomStr] = { status, startTime };
      } else {
        initialDataCache.cleaningStatus[roomStr] = { status };
      }
      console.log('[cache] upsertCleaningStatus', roomStr, initialDataCache.cleaningStatus[roomStr]);
    } catch (e) {
      console.warn('[cache] upsertCleaningStatus failed', e?.message || e);
    }
  },
  addInspectionLog: (log) => {
    try {
      if (!initialDataCache) return;
      initialDataCache.inspectionLogs = initialDataCache.inspectionLogs || [];
      initialDataCache.inspectionLogs.push(log);
      console.log('[cache] addInspectionLog', log.roomNumber);
    } catch (e) {
      console.warn('[cache] addInspectionLog failed', e?.message || e);
    }
  }
  ,
  upsertDndStatus: ({ roomNumber, dndStatus }) => {
    try {
      if (!initialDataCache) return; // nothing cached yet
      const roomStr = String(roomNumber).padStart(3, '0');
      initialDataCache.dndStatus = initialDataCache.dndStatus || {};
      initialDataCache.dndStatus[roomStr] = dndStatus ? 'dnd' : 'available';
      console.log('[cache] upsertDndStatus', roomStr, initialDataCache.dndStatus[roomStr]);
    } catch (e) {
      console.warn('[cache] upsertDndStatus failed', e?.message || e);
    }
  },
  upsertRoomNote: ({ roomNumber, note }) => {
    try {
      if (!initialDataCache) return; // nothing cached yet
      const roomStr = String(roomNumber).padStart(3, '0');
      initialDataCache.roomNotes = initialDataCache.roomNotes || {};
      initialDataCache.roomNotes[roomStr] = note;
      console.log('[cache] upsertRoomNote', roomStr);
    } catch (e) {
      console.warn('[cache] upsertRoomNote failed', e?.message || e);
    }
  }
};
app.set('cacheHelpers', cacheHelpers);

io.on('connection', (socket) => {
    lastActive = Date.now();
    console.log('A user connected via WebSocket');

    socket.on('requestInitialData', async () => {
        try {
            const data = await getOrCacheInitialData();
            socket.emit('initialData', data);
        } catch (error) {
            console.error('Error fetching initial data for WebSocket client:', error);
            socket.emit('initialDataError', { message: 'Failed to fetch initial data.' });
        }
    });

    socket.on('disconnect', () => {
        lastActive = Date.now();
        console.log('User disconnected from WebSocket');
    });
});

const PORT = process.env.PORT || 3001;

// Schedule a task shortly after midnight (00:05) every day in Asia/Phnom_Penh timezone
cron.schedule('5 0 * * *', async () => {
    console.log('Running daily log reset...');
    invalidateCache(); // Invalidate before the transaction
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const today = moment().tz('Asia/Phnom_Penh').startOf('day').toDate();

        // Preserve historical cleaning logs; only clear day-specific collections that should reset
        await InspectionLog.deleteMany({ date: { $lt: today } }).session(session);
        await RoomDND.deleteMany({ date: { $lt: today } }).session(session);

        await session.commitTransaction();
        session.endSession();

        // After reset, ensure today's logs are created and broadcast the reset event
        await ensureTodaysCleaningLogs();
        io.emit('dailyReset');
        console.log('Daily log reset complete.');
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error during daily log reset:', error);
    }
}, {
    timezone: "Asia/Phnom_Penh"
});

server.listen(PORT, async () => {
    console.log(`✅ Server running on port ${PORT}`);

    // On startup, ensure today's cleaning logs exist
    await ensureTodaysCleaningLogs();

    if ((process.env.ENABLE_RESOURCE_LOGS || '').toLowerCase() === 'true') {
        const intervalMs = Math.max(parseInt(process.env.RESOURCE_LOG_INTERVAL_MS || '60000', 10), 10000);
        const logCpuUsage = (process.env.RESOURCE_LOG_INCLUDE_CPU || 'true').toLowerCase() !== 'false';
        console.log(`[diag] Resource logging enabled. Interval: ${intervalMs}ms. CPU tracked: ${logCpuUsage}`);
        let lastCpu = process.cpuUsage();
        setInterval(() => {
            const mem = process.memoryUsage();
            const rssMb = (mem.rss / (1024 * 1024)).toFixed(1);
            const heapUsedMb = (mem.heapUsed / (1024 * 1024)).toFixed(1);
            const heapTotalMb = (mem.heapTotal / (1024 * 1024)).toFixed(1);

            const payload = {
                rssMb,
                heapUsedMb,
                heapTotalMb
            };

            if (logCpuUsage) {
                const currentCpu = process.cpuUsage();
                const userDiff = currentCpu.user - lastCpu.user;
                const systemDiff = currentCpu.system - lastCpu.system;
                lastCpu = currentCpu;
                const cpuMs = (userDiff + systemDiff) / 1000;
                payload.cpuMs = cpuMs.toFixed(1);
                payload.cpuPct = `${((cpuMs / intervalMs) * 100).toFixed(1)}%`;
            }

            console.log("[diag] resource", payload);
        }, intervalMs).unref();
    }
});
