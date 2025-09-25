require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const telegramRoutes = require("./telegram.js");
const multer = require("multer");
const sharp = require('sharp'); // For image compression
const moment = require("moment-timezone");

const fs = require("fs");
const path = require("path");

// ✅ Ensure uploads/ directory exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}



const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const RoomDND = require("./RoomDND"); // ✅ Ensure RoomDND is imported
const allowedOrigins = ["https://housekeepingmanagement.netlify.app"]; // Add your frontend domain

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Replace with your Telegram chat ID




// ✅ Initialize Express
const app = express();
app.use(express.json());
app.use(cors());
app.use("/api", telegramRoutes); // ✅ Add this line

// ✅ Load MongoDB URI
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("❌ MONGO_URI is missing. Check your .env file!");
    process.exit(1);
}

// ✅ Connect to MongoDB using Mongoose (SINGLE Connection)
mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB Connected Successfully"))
.catch(err => console.error("❌ MongoDB connection error:", err));

// ✅ Handle MongoDB Disconnection & Reconnect
mongoose.connection.on("disconnected", () => {
    console.warn("⚠️ MongoDB Disconnected. Attempting Reconnect...");
    mongoose.connect(mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }).catch(err => console.error("❌ MongoDB reconnection failed:", err));
});

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String }, // Optional if using OAuth in future
    refreshToken: { type: String },
    phone: String,
    position: String, // ✅ <-- Add this line
    profileImage: String,
    score: { type: Number, default: 0 },
    lastUpdated: Date
});

const User = mongoose.models.User || mongoose.model("User", userSchema);

const prioritySchema = new mongoose.Schema({
    roomNumber: { type: String, required: true, unique: true },
    priority: { type: String, default: "default" },
    allowCleaningTime: { type: String, default: null } // <-- NEW FIELD!
});
const RoomPriority = mongoose.model("RoomPriority", prioritySchema);

const InspectionLogSchema = new mongoose.Schema({
    roomNumber: String,
    items: { type: Map, of: String }, // Example: { TV: 'clean', Sofa: 'not_clean' }
    updatedBy: String,
    updatedAt: Date
});

const InspectionLog = mongoose.model('InspectionLog', InspectionLogSchema);

const scoreLogSchema = new mongoose.Schema({
  username: String,
  date: Date, // YYYY-MM-DD
  score: Number,
  isFastest: Boolean,
});

const ScoreLog = mongoose.model('ScoreLog', scoreLogSchema);


// ✅ CORS Configuration
app.use(cors({
    origin: "https://housekeepingmanagement.netlify.app",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,  
    allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options("*", cors()); // Allow preflight requests

// ✅ Create HTTP & WebSocket Server
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "https://housekeepingmanagement.netlify.app",
        methods: ["GET", "POST"]
    }
});

// ✅ WebSocket Authentication Middleware
io.use(async (socket, next) => {
    try {
        let token = socket.handshake.auth?.token || 
                    socket.handshake.headers.authorization?.split(" ")[1];

        if (!token) {
            console.warn("⚠ No token provided for WebSocket authentication.");
            return next(new Error("Authentication error"));
        }

        let decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findOne({ username: decoded.username });

        if (!user) {
            console.warn("⚠ WebSocket authentication failed: User not found");
            return next(new Error("Authentication error"));
        }

        socket.user = decoded;
        console.log(`✅ WebSocket Authenticated: ${decoded.username}`);
        next();
    } catch (err) {
        console.warn(`❌ WebSocket Authentication Failed: ${err.message}`);
        next(new Error("Authentication error"));
    }
});

io.on("connection", (socket) => {
    console.log(`⚡ WebSocket Client Connected: ${socket.id}`);

    // Verify if the client is authenticated
    if (!socket.user) {
        console.warn("❌ Unauthorized WebSocket Connection Attempt");
        socket.disconnect(true);
        return;
    }

    console.log(`🔐 WebSocket Authenticated: ${socket.user.username}`);


    socket.on("requestDNDStatus", async () => {
    const dndLogs = await RoomDND.find({}, "roomNumber dndStatus").lean();

    dndLogs.forEach(dnd => {
        socket.emit("dndUpdate", {
            roomNumber: dnd.roomNumber,
            status: dnd.dndStatus ? "dnd" : "available"
        });
    });

    console.log("✅ Sent DND status updates for individual rooms.");
});

socket.on("requestPriorityStatus", async () => {
    try {
        const priorities = await RoomPriority.find({}, "roomNumber priority").lean();
        
        if (!priorities || priorities.length === 0) {
            console.warn("⚠️ No priorities found in database. Sending empty list.");
            socket.emit("priorityStatus", []);
            return;
        }

        // ✅ Ensure roomNumber is always sent as a string
        const formattedPriorities = priorities.map(p => ({
            roomNumber: String(p.roomNumber), // Force roomNumber to string
            priority: p.priority
        }));

        socket.emit("priorityStatus", formattedPriorities);
        console.log("✅ Sent priority statuses to client:", formattedPriorities);
    } catch (error) {
        console.error("❌ Error sending priority statuses:", error);
    }
});

socket.on("allowCleaningUpdate", async ({ roomNumber, time }) => {
    try {
        await RoomPriority.findOneAndUpdate(
            { roomNumber: String(roomNumber) },
            { priority: "allow", allowCleaningTime: time },
            { upsert: true, new: true }
        );

        io.emit("allowCleaningUpdate", { roomNumber: String(roomNumber), time });
        console.log(`✅ Allow cleaning time updated for Room ${roomNumber}`);
    } catch (err) {
        console.error("❌ Error updating allow cleaning time:", err);
    }
});


socket.on("priorityUpdate", async ({ roomNumber, priority, allowCleaningTime }) => {
    try {
        await RoomPriority.findOneAndUpdate(
            { roomNumber: String(roomNumber) },
            { priority, allowCleaningTime: allowCleaningTime || null },
            { upsert: true, new: true }
        );

        io.emit("priorityUpdate", { roomNumber: String(roomNumber), priority, allowCleaningTime });
    } catch (error) {
        console.error("❌ Error updating priority:", error);
    }
});


socket.on("updatePriorityStatus", (data) => {
    io.emit("updatePriorityStatus", data);
});

socket.on("updatePriorityStatus", (data) => {
    console.log("🔄 Priority status update received:", data);
    document.querySelectorAll(".priority-toggle").forEach(button => {
        button.innerHTML = "⚪"; // Reset to default state
    });
});

    // Backend: After successful connection
    socket.on("requestCheckedRooms", async () => {
        const checkedLogs = await CleaningLog.find({ status: "checked" }, "roomNumber").lean();
        const checkedRooms = checkedLogs.map(log => log.roomNumber);

        socket.emit("checkedRoomsStatus", checkedRooms); // Custom event
    });

     /** 📝 Inspection Update Listener */
    socket.on('inspectionUpdate', async ({ roomNumber, item, status, updatedBy }) => {
        try {
            console.log(`📝 Received inspection update: Room ${roomNumber}, Item: ${item}, Status: ${status}`);

            // Update or insert inspection log
            await InspectionLog.updateOne(
                { roomNumber },
                { 
                    $set: { [`items.${item}`]: status, updatedBy: updatedBy, updatedAt: new Date() },
                    $setOnInsert: { roomNumber }
                },
                { upsert: true }
            );

            // Broadcast to all connected clients
            io.emit('inspectionUpdate', { roomNumber, item, status, updatedBy });

            console.log(`✅ Broadcasted inspection update for Room ${roomNumber}`);
        } catch (err) {
            console.error('❌ Failed to process inspection update:', err);
        }
    });

    socket.on('requestInspectionLogs', async () => {
    try {
        const logs = await InspectionLog.find({});
        socket.emit('inspectionLogsStatus', logs); // Send full logs back to this client
        console.log(`📡 Sent current inspection logs to ${socket.id}`);
    } catch (err) {
        console.error('❌ Failed to fetch inspection logs:', err);
    }
});


// ✅ Handle Room Checked WebSocket Event
    socket.on("roomChecked", async ({ roomNumber, username }) => {
        try {
            await CleaningLog.findOneAndUpdate(
                { roomNumber, finishTime: { $ne: null } }, 
                { $set: { checkedTime: new Date().toLocaleString(), checkedBy: username, status: "checked" } },
                { new: true }
            );

            io.emit("roomChecked", { roomNumber: String(roomNumber).padStart(3, "0"), status: "checked", checkedBy: username });
        } catch (error) {
            console.error("❌ WebSocket Error: Room Checked", error);
        }
    });

    socket.on("resetCheckedRooms", () => {
        console.log("🧹 Resetting checked rooms on all clients...");
        io.emit("resetCheckedRooms"); // Broadcast to ALL clients
    });
    
socket.on("dndUpdate", async ({ roomNumber, status }) => {
    try {
        if (!roomNumber) {
            console.warn("⚠️ Invalid DND update request. Skipping...");
            return;
        }

        console.log(`📡 Processing DND update for Room ${roomNumber} -> ${status}`);

        // ✅ Update the DND status in the database
        const updatedRoom = await RoomDND.findOneAndUpdate(
            { roomNumber },
            { $set: { dndStatus: status === "dnd" } },
            { upsert: true, new: true }
        );

        if (!updatedRoom) {
            console.warn(`⚠️ Room ${roomNumber} not found in database. Skipping update.`);
            return;
        }

        // ✅ Emit WebSocket event only for this specific room
        io.emit("dndUpdate", {
            roomNumber: updatedRoom.roomNumber,
            status: updatedRoom.dndStatus ? "dnd" : "available"
        });

        console.log(`✅ Successfully processed DND update for Room ${roomNumber}`);

    } catch (error) {
        console.error("❌ Error processing DND update:", error);
    }
});

    // ✅ Handle Cleaning Reset
    socket.on("resetCleaning", async ({ roomNumber }) => {
    if (!roomNumber) {
        console.warn("⚠️ Invalid Cleaning Reset request");
        return;
    }

    console.log(`🔄 Checking if Room ${roomNumber} exists...`);
    const roomExists = await CleaningLog.findOne({ roomNumber });

    if (!roomExists) {
        console.warn(`⚠️ Room ${roomNumber} does not exist in the database.`);
        return;
    }

    console.log(`✅ Resetting Cleaning Status for Room ${roomNumber}`);
    io.emit("resetCleaning", { roomNumber, status: "available" });
});

    socket.on("disconnect", (reason) => {
        console.warn(`🔴 WebSocket Client Disconnected: ${reason}`);
        socket.removeAllListeners(); // ✅ Removes all event listeners
    });
});

// ✅ Store `io` in Express
app.set("io", io);

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: "No token provided" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Invalid token" });
        req.user = user;
        next();
    });
}



// ✅ User Signup (Fixed Duplicate User Check)
app.post("/auth/signup", async (req, res) => {
    const { username, password } = req.body;
    try {
        if (await User.findOne({ username })) {
            return res.status(400).json({ message: "User already exists." });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await new User({ username, password: hashedPassword }).save();
        res.status(201).json({ message: "User registered successfully!" });
    } catch (error) {
        console.error("❌ Signup Error:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

// ✅ Login Route
app.post("/auth/login", async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ message: "Missing username or password" });
        }

        if (mongoose.connection.readyState !== 1) {
            return res.status(500).json({ message: "Database not connected" });
        }

        const user = await User.findOne({ username });
        if (!user) {
            console.warn(`❌ Login Failed: User not found - ${username}`);
            return res.status(401).json({ message: "Invalid username or password" });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            console.warn(`❌ Login Failed: Incorrect password for ${username}`);
            return res.status(401).json({ message: "Invalid username or password" });
        }

        // ✅ Generate JWT token
        const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: "16h" });
        const refreshToken = jwt.sign({ username: user.username }, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });

        user.refreshToken = refreshToken;
        await user.save();

        console.log(`✅ Login successful for: ${username}`);
        res.json({ message: "Login successful", token, refreshToken, username });
    } catch (error) {
        console.error("❌ Server Error on Login:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// ✅ Refresh Token Handling (Fixed Missing User Check)
app.post("/auth/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    try {
        if (!refreshToken) return res.status(401).json({ message: "No refresh token provided" });

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const user = await User.findOne({ username: decoded.username, refreshToken });

        if (!user) return res.status(403).json({ message: "Invalid refresh token" });

        const newAccessToken = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: "1h" });
        const newRefreshToken = jwt.sign({ username: user.username }, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });

        user.refreshToken = newRefreshToken;
        await user.save();

        res.json({ token: newAccessToken, refreshToken: newRefreshToken });
    } catch (error) {
        console.error("❌ Refresh Token Error:", error);
        res.status(403).json({ message: "Invalid refresh token" });
    }
});

// ✅ Logout Route
app.post("/auth/logout", async (req, res) => {
    const { username } = req.body;
    try {
        await User.updateOne({ username }, { $unset: { refreshToken: "" } });
        res.json({ message: "✅ Logged out successfully." });
    } catch (error) {
        console.error("❌ Logout Error:", error);
        res.status(500).json({ message: "Server error", error });
    }
});


// ✅ Validate Token Route
app.get("/auth/validate", (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ valid: false, message: "No token provided" });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ valid: false, message: "Invalid token" });
        res.json({ valid: true, user: decoded });
    });
});

// 🔄 Get Room Cleaning Status
app.get("/logs/status", async (req, res) => {
    try {
        const logs = await CleaningLog.find();

        let status = {};

        logs.forEach(log => {
            const roomStr = String(log.roomNumber).padStart(3, "0"); // ✅ Convert to string, pad to 3 digits
            if (log.checkedTime) {
                status[roomStr] = "checked";
            } else if (log.finishTime) {
                status[roomStr] = "finished";
            } else if (log.startTime) {
                status[roomStr] = "in_progress";
            } else {
                status[roomStr] = "not_started";
            }
        });

        console.log("📌 Backend Sending Room Statuses:", status);
        res.json(status);
    } catch (error) {
        console.error("❌ Error fetching room status:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

app.post("/logs/inspection", authenticateToken, async (req, res) => {
    const { roomNumber, item, status, username } = req.body;

    try {
        await InspectionLog.updateOne(
            { roomNumber },
            { 
                $set: { [`items.${item}`]: status, updatedBy: username, updatedAt: new Date() },
                $setOnInsert: { roomNumber }
            },
            { upsert: true }
        );

        io.emit("inspectionUpdate", { roomNumber, item, status, updatedBy: username });
        res.status(200).json({ message: "Inspection updated successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to update inspection" });
    }
});


app.get('/logs/inspection', authenticateToken, async (req, res) => {
    try {
        const logs = await InspectionLog.find({});
        res.status(200).json(logs);
    } catch (err) {
        console.error('❌ Failed to fetch inspection logs:', err);
        res.status(500).json({ message: 'Failed to retrieve inspection logs' });
    }
});


app.get("/logs/priority", async (req, res) => {
    try {
        const priorities = await RoomPriority.find({}, "roomNumber priority allowCleaningTime").lean();

        const formattedPriorities = priorities.map(p => ({
            roomNumber: String(p.roomNumber).padStart(3, "0"),
            priority: p.priority || "default",
            allowCleaningTime: p.allowCleaningTime || null // Include here
        }));

        res.json(formattedPriorities);
        console.log("✅ Returning priority data:", formattedPriorities);
    } catch (error) {
        console.error("❌ Error fetching priorities:", error);
        res.status(500).json({ message: "Server error", error });
    }
});



app.post("/logs/priority", async (req, res) => {
    try {
        let { roomNumber, priority, allowCleaningTime } = req.body;
        if (!roomNumber || !priority) {
            return res.status(400).json({ message: "Room number and priority are required." });
        }

        roomNumber = String(roomNumber).padStart(3, "0");

        await RoomPriority.findOneAndUpdate(
            { roomNumber },
            { priority, allowCleaningTime: allowCleaningTime || null },
            { upsert: true, new: true }
        );

        // Emit to all clients
        io.emit("priorityUpdate", { roomNumber, priority, allowCleaningTime });

        res.json({ message: "Priority updated successfully" });
    } catch (error) {
        console.error("❌ Error updating priority:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

app.post("/logs/dnd", async (req, res) => {
    try {
        const { roomNumber, status } = req.body;

        if (!roomNumber) {
            return res.status(400).json({ message: "Room number is required." });
        }

        console.log(`🔍 Incoming DND Update -> Room: ${roomNumber}, Status: ${status}`);

        const updatedRoom = await RoomDND.findOneAndUpdate(
            { roomNumber },
            { $set: { dndStatus: status === "dnd" } },
            { upsert: true, new: true }
        );

        if (!updatedRoom) {
            throw new Error(`Update failed for Room ${roomNumber}`);
        }

        // ✅ Emit only the affected room
        io.emit("dndUpdate", { roomNumber, status });

        console.log(`✅ Room ${roomNumber} DND mode updated -> ${status}`);
        res.json({ message: `DND mode ${status} for Room ${roomNumber}`, updatedRoom });
    } catch (error) {
        console.error("❌ Server Error updating DND status:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
});


app.get("/logs/dnd", async (req, res) => {
    try {
        console.log("🔄 Fetching latest DND statuses...");
        const dndLogs = await RoomDND.find({}, "roomNumber dndStatus").lean();

        if (!dndLogs || dndLogs.length === 0) {
            return res.json([]); // ✅ Always return an array
        }

        console.log("✅ Successfully fetched DND logs:", dndLogs);
        res.json(dndLogs);
    } catch (error) {
        console.error("❌ Error fetching DND statuses:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});



// ✅ Reset Cleaning Status When DND is Turned Off
app.post("/logs/reset-cleaning", async (req, res) => {
    try {
        let { roomNumber } = req.body;

        if (!roomNumber || isNaN(roomNumber)) {
            return res.status(400).json({ message: "Room number must be a valid number." });
        }

        roomNumber = parseInt(roomNumber, 10); // Convert to a number

        console.log(`🔄 Resetting cleaning status for Room ${roomNumber}...`);

        // ✅ Fetch log without modifying DND mode
        const existingLog = await CleaningLog.findOne({ roomNumber });

        if (!existingLog) {
            console.warn(`⚠️ Room ${roomNumber} not found in logs. Cannot reset.`);
            return res.status(400).json({ message: `Room ${roomNumber} not found in logs.` });
        }

        // ✅ Only reset cleaning status (Do NOT change DND mode)
        await CleaningLog.updateOne(
            { _id: existingLog._id },
            {
                $set: {
                    startTime: null,
                    finishTime: null,
                    startedBy: null,
                    finishedBy: null,
                    status: "available"
                }
            }
        );

        console.log(`✅ Cleaning status reset successfully for Room ${roomNumber}.`);

        io.emit("resetCleaning", { roomNumber, status: "available" });

        res.json({ message: `✅ Cleaning status reset for Room ${roomNumber}` });

    } catch (error) {
        console.error("❌ Error resetting cleaning status:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
});


// ✅ Graceful Shutdown: Close DB Connection on Exit
process.on("SIGINT", async () => {
    if (db) {
        console.log("🔴 Closing MongoDB Client Connection...");
        await db.close();
    }
    console.log("🔴 Closing Mongoose Connection...");
    await mongoose.connection.close();
    process.exit(0);
});

async function sendMessageToTelegram(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log("✅ Telegram message sent:", message);
    } catch (error) {
        console.error("❌ Error sending Telegram message:", error);
    }
}

// ✅ API Route to Send Telegram Messages
app.post("/send-telegram", async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
        });

        if (response.data.ok) {
            return res.json({ success: true, message: "Message sent to Telegram" });
        } else {
            return res.status(500).json({ error: "Failed to send message to Telegram" });
        }
    } catch (error) {
        console.error("Telegram API Error:", error);
        return res.status(500).json({ error: "Telegram API request failed" });
    }
});


// 🚀 Start Cleaning

app.post("/logs/start", async (req, res) => {
    try {
        let { roomNumber, username } = req.body;
        if (!roomNumber || isNaN(roomNumber) || !username ) {
            return res.status(400).json({ message: "❌ Invalid room number" });
        }

        roomNumber = parseInt(roomNumber, 10);

        const existingLog = await CleaningLog.findOne({ roomNumber, finishTime: null });
        if (existingLog) {
            return res.status(400).json({ message: `⚠ Room ${roomNumber} is already being cleaned.` });
        }

        const startTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" });

        const log = await CleaningLog.findOneAndUpdate(
            { roomNumber },
            { $set: { startTime, startedBy: username, finishTime: null, finishedBy: null, status: "in_progress" } },
            { upsert: true, new: true }
        );
        
        if (!log) {
            return res.status(500).json({ message: "Database update failed." });
        }

       // ✅ Emit event only after successful DB update
        io.emit("roomUpdate", { roomNumber, status: "in_progress", previousStatus: "available" });

        res.status(201).json({ message: `✅ Room ${roomNumber} started by ${username} at ${startTime}` });

    } catch (error) {
        console.error("❌ Start Cleaning Error:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

// ✅ Finish Cleaning - FIXED
app.post("/logs/finish", async (req, res) => {
    console.log("📥 Received Finish Request:", req.body);

    let { roomNumber, username, finishTime, status } = req.body;

    if (!roomNumber || !username) {
        console.error("❌ Missing required fields:", req.body);
        return res.status(400).json({ message: "Missing required fields" });
    }

    roomNumber = parseInt(roomNumber, 10); // Convert to number ✅
    finishTime = finishTime || new Date().toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" });
    status = status || "finished";

    try {
        console.log(`🔍 Checking for unfinished log for Room ${roomNumber}...`);
        
        // ✅ Fetch log to get previousStatus before updating
        const log = await CleaningLog.findOne({ roomNumber, finishTime: null });
        
        if (!log) {
            console.warn(`⚠️ Log not found or already finished for Room ${roomNumber}`);
            return res.status(400).json({ message: "Log not found or already finished" });
        }

        // ✅ Capture previous status before updating
        let previousStatus = log.startTime ? "in_progress" : "available";

        // ✅ Update Cleaning Log in Database
        const updatedLog = await CleaningLog.findOneAndUpdate(
            { roomNumber, finishTime: null },
            {
                $set: {
                    finishTime,
                    finishedBy: username,
                    status: "finished"
                }
            },
            { new: true }
        );

        if (!updatedLog) {
            console.error("❌ Database update failed.");
            return res.status(500).json({ message: "Failed to update cleaning status." });
        }

        console.log(`✅ Room ${roomNumber} finished by ${username} at ${finishTime}`);

        // ✅ Notify all WebSocket clients
        io.emit("roomUpdate", { roomNumber, status: "finished", previousStatus });

        res.status(200).json({ message: `Room ${roomNumber} finished by ${username}` });

    } catch (error) {
        console.error("❌ Finish Cleaning Error:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});
const logSchema = new mongoose.Schema({
    roomNumber: { type: Number, required: true }, // ✅ Ensure roomNumber is a Number
    startTime: { type: String, default: null },
    startedBy: { type: String, default: null },
    finishTime: { type: String, default: null },
    finishedBy: { type: String, default: null },
    checkedTime: { type: String, default: null },  // ✅ NEW: Store when Checked button is clicked
    checkedBy: { type: String, default: null },    // ✅ NEW: Store who clicked Checked
    dndStatus: { type: Boolean, default: false }, // ✅ DND Mode
    status: { type: String, default: "available" }
});

// ✅ Ensure model is only defined once
const CleaningLog = mongoose.models.CleaningLog || mongoose.model("CleaningLog", logSchema);

module.exports = CleaningLog;

async function fixRoomNumbers() {
    try {
        console.log("🔄 Fixing room number formats in database...");
        const logs = await CleaningLog.find();
        let updatedCount = 0;

        for (let log of logs) {
            if (typeof log.roomNumber !== "number" || isNaN(log.roomNumber)) {
                log.roomNumber = parseInt(log.roomNumber, 10);

                if (!isNaN(log.roomNumber)) { // Ensure it's a valid number
                    await log.save();
                    updatedCount++;
                    console.log(`✅ Updated Room: ${log.roomNumber}`);
                } else {
                    console.warn(`⚠️ Skipping invalid room number: ${log.roomNumber}`);
                }
            }
        }

        console.log(`✅ Fixed ${updatedCount} room numbers successfully.`);
    } catch (error) {
        console.error("❌ Error fixing room numbers:", error);
    }
}

// ✅ Run this function AFTER connecting to MongoDB
mongoose.connection.once("open", async () => {
    console.log("✅ Database connected. Running room number fix...");
    await fixRoomNumbers();
});

// ✅ Mark Room as Checked
app.post("/logs/check", async (req, res) => {
    let { roomNumber, username } = req.body;
    if (!roomNumber || !username) {
        return res.status(400).json({ message: "Room number and username are required" });
    }

    roomNumber = parseInt(roomNumber, 10); // Convert to number
    const checkedTime = new Date().toISOString(); // Use ISO format here (better consistency!)

    try {
        const updatedLog = await CleaningLog.findOneAndUpdate(
            { roomNumber, finishTime: { $ne: null }, checkedTime: null },
            { $set: { checkedTime, checkedBy: username, status: "checked" } },
            { new: true }
        );

        if (!updatedLog) {
            return res.status(400).json({ message: "Room not found or already checked." });
        }

        // ✅ Emit WebSocket event with timestamp included
        io.emit("roomChecked", { 
            roomNumber, 
            status: "checked", 
            checkedBy: username, 
            checkedTime 
        });

        res.status(200).json({ message: `Room ${roomNumber} checked by ${username}` });

    } catch (error) {
        console.error("❌ Error in /logs/check:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// ✅ Update Profile with Base64 Profile Image
app.post("/user/update-profile", authenticateToken, upload.single("profileImage"), async (req, res) => {
  try {
    const username = req.user.username;
    const { phone, position, password } = req.body;

    // ✅ Step 1: Convert image to base64 and compress
    let base64Image = null;
    if (req.file) {
      const compressed = await sharp(req.file.buffer)
        .resize(80, 80)
        .jpeg({ quality: 60 })
        .toBuffer();

      base64Image = `data:image/jpeg;base64,${compressed.toString("base64")}`;
    }

    // ✅ Step 2: Prepare update fields
    const updateFields = {};
    if (phone) updateFields.phone = phone;
    if (position) updateFields.position = position;
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      updateFields.password = hashed;
    }
    if (base64Image) updateFields.profileImage = base64Image;

    // ✅ Step 3: Update user in DB
    await User.updateOne({ username }, { $set: updateFields });

    res.json({ success: true, message: "Profile updated" });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ success: false, message: "Update failed" });
  }
});



// Serve uploaded files statically
app.use("/uploads", express.static("uploads"));

app.get("/user/profile", authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Extract safe profile data
    const { phone = "", position = "", profileImage = "", username: name } = user;


    // Get score for current month
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const scores = await ScoreLog.find({
      username,
      date: { $gte: start, $lte: end }
    });

    res.json({
      success: true,
      username: name,
      phone,
      position,
      profileImage,
      score: scores.length
    });


  } catch (error) {
    console.error("❌ Error fetching profile:", error);
    res.status(500).json({ success: false, message: "Failed to fetch profile", error: error.message });
  }
});

app.post("/score/reward-fastest", authenticateToken, async (req, res) => {
  const cambodiaNow = moment.tz("Asia/Phnom_Penh").toDate();

  // ✅ Allow one reward per DAY instead
  const startOfDay = moment(cambodiaNow).startOf("day").toDate();
  const endOfDay = moment(cambodiaNow).endOf("day").toDate();

  const logs = await CleaningLog.find({
    startTime: { $ne: null },
    finishTime: { $ne: null }
  });

  if (!logs || logs.length === 0) {
    return res.status(404).json({ message: "No completed cleaning logs." });
  }

  // Calculate duration per user
  const userStats = {};
  logs.forEach(log => {
    const startTime = new Date(log.startTime);
    const finishTime = new Date(log.finishTime);
    const duration = (finishTime - startTime) / 60000; // in minutes

    if (log.finishedBy && duration > 0) {
      if (!userStats[log.finishedBy]) {
        userStats[log.finishedBy] = { total: 0, count: 0 };
      }
      userStats[log.finishedBy].total += duration;
      userStats[log.finishedBy].count++;
    }
  });

  let fastestUser = null;
  let bestAvg = Infinity;

  for (let user in userStats) {
    const avg = userStats[user].total / userStats[user].count;
    if (avg < bestAvg) {
      bestAvg = avg;
      fastestUser = user;
    }
  }

  if (!fastestUser) {
    return res.status(404).json({ message: "No eligible user found." });
  }

  // ✅ Check if already rewarded today
  const alreadyRewarded = await ScoreLog.findOne({
    username: fastestUser,
    date: { $gte: startOfDay, $lte: endOfDay }
  });

  if (alreadyRewarded) {
    return res.status(409).json({ message: "Already rewarded today." });
  }

  await new ScoreLog({
    username: fastestUser,
    date: cambodiaNow,
    isFastest: true
  }).save();

  return res.json({ success: true, fastestUser });
});


app.post("/score/add", authenticateToken, async (req, res) => {
  const username = req.user.username;
  const cambodiaNow = moment.tz("Asia/Phnom_Penh").toDate();

  // ✅ Allow one reward per DAY instead
  const startOfDay = moment(cambodiaNow).startOf("day").toDate();
  const endOfDay = moment(cambodiaNow).endOf("day").toDate();

  const existing = await ScoreLog.findOne({
    username,
    date: { $gte: startOfDay, $lte: endOfDay }
  });

  if (existing) {
    return res.status(409).json({ message: "Already rewarded today." });
  }

  const log = new ScoreLog({ username, date: cambodiaNow });
  await log.save();

  res.json({ success: true, message: "Score added" });
});

app.get("/score/leaderboard", authenticateToken, async (req, res) => {
  try {
    const leaderboard = await ScoreLog.aggregate([
      {
        $match: { isFastest: true } // ✅ Only include fastest rewards
      },
      {
        $group: {
          _id: "$username",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 3 }
    ]);

    // 🔄 Add profileImage for each user
    for (const entry of leaderboard) {
      const user = await User.findOne({ username: entry._id });
      entry.profileImage = user?.profileImage || null;
    }

    res.json(leaderboard);
  } catch (err) {
    console.error("❌ Leaderboard error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


app.get("/user/all", authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, "username phone position profileImage");
    res.json(users);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ message: "Failed to retrieve users" });
  }
});


app.get("/logs", async (req, res) => {
    try {
        const logs = await CleaningLog.find();

        const fixedLogs = logs.map(log => ({
            ...log.toObject(),
            roomNumber: String(log.roomNumber).padStart(3, "0") // Convert to padded string
        }));

        console.log("✅ Sending logs with padded room numbers:", fixedLogs);

        res.json(fixedLogs);
    } catch (error) {
        res.status(500).json({ message: "Server error", error });
    }
});

const allRoomNumbers = [
    "001", "002", "003", "004", "005", "006", "007",
    "011", "012", "013", "014", "015", "016", "017",
    "101", "102", "103", "104", "105", "106", "107", "108", "109", "110",
    "111", "112", "113", "114", "115", "116", "117",
    "201", "202", "203", "204", "205", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217"
];

app.post("/logs/clear", async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        console.log("🧹 Initiating full housekeeping logs reset...");

        /** 🔸 1. CLEAR CLEANING LOGS */
        const logCount = await CleaningLog.countDocuments().session(session);
        if (logCount > 0) {
            await CleaningLog.deleteMany({}).session(session);
            console.log(`✅ Cleared ${logCount} cleaning logs.`);
        } else {
            console.log("ℹ️ No cleaning logs found.");
        }

        /** 🔸 2. RESET DND STATUS */
        const dndReset = await RoomDND.updateMany({}, { $set: { dndStatus: false } }).session(session);
        console.log(`✅ Reset DND status for ${dndReset.modifiedCount} rooms.`);

        const dndLogs = await RoomDND.find({}, "roomNumber dndStatus").lean();

        /** 🔸 3. RESET PRIORITIES */
        const priorityReset = await RoomPriority.updateMany({}, { $set: { priority: "default" } }).session(session);
        console.log(`✅ Reset priorities for ${priorityReset.modifiedCount} rooms.`);

        /** 🔸 4. CLEAR INSPECTION LOGS */
        const inspectionCount = await InspectionLog.countDocuments().session(session);
        if (inspectionCount > 0) {
            await InspectionLog.deleteMany({}).session(session);
            console.log(`✅ Cleared ${inspectionCount} inspection logs.`);
        } else {
            console.log("ℹ️ No inspection logs found.");
        }

        /** 🔸 5. COMMIT TRANSACTION */
        await session.commitTransaction();
        session.endSession();
        console.log("✅ All housekeeping logs & statuses reset successfully.");

        /** 🔸 6. EMIT SOCKET EVENTS FOR CLIENT SYNC */
        io.emit("clearLogs");
        io.emit("dndUpdate", { roomNumber: "all", status: "available", dndLogs });
        io.emit("priorityUpdate", { roomNumber: "all", priority: "default" });
        io.emit("resetCheckedRooms");
        io.emit("inspectionLogsCleared");

        // Reset cleaning buttons for all rooms
        allRoomNumbers.forEach(roomNumber => {
            io.emit("resetCleaning", { roomNumber, status: "available" });
            console.log(`🔄 Reset Cleaning Button for Room ${roomNumber}`);
        });

        return res.status(200).json({
            message: "✅ All logs, DND, priorities, checked statuses, and inspection logs cleared successfully.",
            dndLogs
        });

    } catch (error) {
        console.error("❌ Error during logs reset:", error);

        await session.abortTransaction();
        session.endSession();

        return res.status(500).json({ message: "Internal server error. Logs reset failed." });
    }
});


// 🏠 Home Route
app.get("/", (req, res) => {
    res.send("Housekeeping Management API is Running 🚀");
});

// ✅ Start Server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});