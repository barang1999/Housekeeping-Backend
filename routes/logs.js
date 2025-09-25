const express = require("express");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const multer = require("multer");

const CleaningLog = require("../models/CleaningLog");
const InspectionLog = require("../models/InspectionLog");
const RoomDND = require("../models/RoomDND");
const RoomPriority = require("../models/RoomPriority");
const { authenticateToken } = require("./auth");
const RoomNote = require("../models/RoomNote");

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const allRoomNumbers = [
    "001", "002", "003", "004", "005", "006", "007",
    "011", "012", "013", "014", "015", "016", "017",
    "101", "102", "103", "104", "105", "106", "107", "108", "109", "110",
    "111", "112", "113", "114", "115", "116", "117",
    "201", "202", "203", "204", "205", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217"
];

router.get("/logs/status", async (req, res) => {
    try {
        const logs = await CleaningLog.find();
        let status = {};
        logs.forEach(log => {
            const roomStr = String(log.roomNumber).padStart(3, "0");
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
        res.json(status);
    } catch (error) {
        console.error("❌ Error fetching room status:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.post("/logs/inspection", authenticateToken, async (req, res) => {
    const { roomNumber, item, status, username } = req.body;
    const io = req.app.get('io');
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

router.get('/logs/inspection', authenticateToken, async (req, res) => {
    try {
        const logs = await InspectionLog.find({});
        res.status(200).json(logs);
    } catch (err) {
        console.error('❌ Failed to fetch inspection logs:', err);
        res.status(500).json({ message: 'Failed to retrieve inspection logs' });
    }
});

// Add a new GET endpoint to fetch a single inspection log by roomNumber
router.get('/logs/inspection/:roomNumber', authenticateToken, async (req, res) => {
    try {
        const { roomNumber } = req.params;
        const log = await InspectionLog.findOne({ roomNumber });
        if (!log) {
            return res.status(404).json({ message: 'Inspection log not found for this room.' });
        }
        res.status(200).json(log);
    } catch (err) {
        console.error('❌ Failed to fetch single inspection log:', err);
        res.status(500).json({ message: 'Failed to retrieve inspection log' });
    }
});

router.post("/inspection/submit", authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    const { roomNumber, inspectionResults, overallScore, timestamp } = req.body;
    const { username } = req.user; // Get username from authenticated token

    try {
        // Find and update the inspection log for the room, or create if it doesn't exist
        const updatedLog = await InspectionLog.findOneAndUpdate(
            { roomNumber },
            {
                $set: {
                    items: inspectionResults, // Store all inspection results as a Map
                    overallScore: overallScore,
                    updatedBy: username,
                    updatedAt: timestamp || new Date().toISOString()
                }
            },
            { upsert: true, new: true } // Create if not found, return the new document
        );

        io.emit("inspectionSubmitted", { roomNumber, overallScore, updatedBy: username });
        res.status(200).json({ message: "Inspection submitted successfully", log: updatedLog });

    } catch (err) {
        console.error("❌ Error submitting inspection:", err);
        res.status(500).json({ message: "Failed to submit inspection", error: err.message });
    }
});

router.get("/logs/priority", async (req, res) => {
    try {
        const priorities = await RoomPriority.find({}, "roomNumber priority allowCleaningTime").lean();
        const formattedPriorities = priorities.map(p => ({
            roomNumber: String(p.roomNumber).padStart(3, "0"),
            priority: p.priority || "default",
            allowCleaningTime: p.allowCleaningTime || null
        }));
        res.json(formattedPriorities);
    } catch (error) {
        console.error("❌ Error fetching priorities:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.post("/logs/priority", async (req, res) => {
    const io = req.app.get('io');
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

        io.emit("priorityUpdate", { roomNumber, priority, allowCleaningTime });

        res.json({ message: "Priority updated successfully" });
    } catch (error) {
        console.error("❌ Error updating priority:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.post("/logs/dnd", authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        let { roomNumber, dndStatus, username } = req.body;
        const dndSetBy = (req.user && req.user.username) || username; // Allow fallback from body (mirrors Finish flow)

        console.log("logs/dnd POST: req.user", req.user);
        console.log("logs/dnd POST: dndSetBy", dndSetBy);

        if (!roomNumber) {
            return res.status(400).json({ message: "Room number is required." });
        }

        if (!dndSetBy) {
            return res.status(401).json({ message: "User not found" });
        }

        const updatedRoom = await RoomDND.findOneAndUpdate(
            { roomNumber },
            { 
                $set: { 
                    dndStatus: dndStatus, 
                    dndReason: null, // Always null if reason is removed
                    dndSetBy: dndSetBy,   // Clear setBy if DND is off
                    dndSetAt: dndStatus ? new Date() : null  // Clear setAt if DND is off
                } 
            },
            { upsert: true, new: true }
        );

        if (!updatedRoom) {
            throw new Error(`Update failed for Room ${roomNumber}`);
        }

        console.log("[push] trigger DND for room", String(roomNumber).padStart(3, "0"), "->", updatedRoom.dndStatus, "by", dndSetBy);
        io.emit("dndUpdate", { 
            roomNumber: String(roomNumber).padStart(3, "0"), 
            dndStatus: updatedRoom.dndStatus, 
            dndReason: updatedRoom.dndReason,
            dndSetBy: updatedRoom.dndSetBy,
            dndSetAt: updatedRoom.dndSetAt
        });
        // Web Push: DND toggled
        const sendPushDND = req.app.get("sendPush");
        if (sendPushDND) {
            try {
                console.log("[push] sending DND push for", String(roomNumber).padStart(3, "0"));
                await sendPushDND({
                    title: updatedRoom.dndStatus ? "Do Not Disturb ON" : "Do Not Disturb OFF",
                    body: `Room ${String(roomNumber).padStart(3, "0")} • by ${dndSetBy}`,
                    tag: `room-${String(roomNumber).padStart(3, "0")}-dnd`,
                    data: { roomNumber: String(roomNumber).padStart(3, "0"), dndStatus: updatedRoom.dndStatus }
                });
            } catch (e) {
                console.error("[push] DND push error:", e?.statusCode || "", e?.message || e);
            }
        }

        res.json({ message: `DND mode ${dndStatus ? "enabled" : "disabled"} for Room ${roomNumber}`, updatedRoom });
    } catch (error) {
        console.error("❌ Server Error updating DND status:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
});

router.get("/logs/dnd", authenticateToken, async (req, res) => {
    try {
        const dndLogs = await RoomDND.find({}).lean(); // Removed populate
        if (!dndLogs || dndLogs.length === 0) {
            return res.json([]);
        }
        res.json(dndLogs);
    } catch (error) {
        console.error("❌ Error fetching DND statuses:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

router.post("/logs/reset-cleaning", async (req, res) => {
    const io = req.app.get('io');
    try {
        let { roomNumber } = req.body;

        if (!roomNumber || isNaN(roomNumber)) {
            return res.status(400).json({ message: "Room number must be a valid number." });
        }

        roomNumber = parseInt(roomNumber, 10);

        const existingLog = await CleaningLog.findOne({ roomNumber });

        if (!existingLog) {
            return res.status(400).json({ message: `Room ${roomNumber} not found in logs.` });
        }

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

        io.emit("resetCleaning", { roomNumber, status: "available" });

        res.json({ message: `✅ Cleaning status reset for Room ${roomNumber}` });

    } catch (error) {
        console.error("❌ Error resetting cleaning status:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
});

router.post("/logs/start", authenticateToken, async (req, res) => {
    const io = req.app.get('io');
    try {
        let { roomNumber } = req.body;
        const { username } = req.user;
        if (!roomNumber || isNaN(roomNumber)) {
            return res.status(400).json({ message: "DEBUG: Initial validation failed" });
        }

        roomNumber = parseInt(roomNumber, 10);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const existingLog = await CleaningLog.findOne({
            roomNumber,
            date: { $gte: today, $lt: tomorrow },
            finishTime: null
        });

        if (existingLog && existingLog.startTime) {
            return res.status(400).json({ message: `⚠ Room ${roomNumber} is already being cleaned.` });
        }

        const startTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" });

        const log = await CleaningLog.findOneAndUpdate(
            { roomNumber, date: { $gte: today, $lt: tomorrow } },
            { $set: { startTime, startedBy: username, finishTime: null, finishedBy: null, status: "in_progress" } },
            { upsert: true, new: true }
        );
        
        if (!log) {
            return res.status(500).json({ message: "Database update failed." });
        }

        const updatePayload = { roomNumber: String(roomNumber).padStart(3, "0"), status: "in_progress", previousStatus: "available" };
        console.log("Emitting roomUpdate from /logs/start:", updatePayload);
        io.emit("roomUpdate", updatePayload);
        // Web Push: Cleaning Started
        const sendPushStart = req.app.get("sendPush");
        if (sendPushStart) {
            try {
                console.log("[push] sending START push for", String(roomNumber).padStart(3, "0"), "by", username);
                await sendPushStart({
                    title: "Cleaning Started",
                    body: `Room ${String(roomNumber).padStart(3, "0")} started by ${username}`,
                    tag: `room-${String(roomNumber).padStart(3, "0")}-started`,
                    data: { roomNumber: String(roomNumber).padStart(3, "0") }
                });
            } catch (e) {
                console.error("[push] START push error:", e?.statusCode || "", e?.message || e);
            }
        }

        res.status(201).json({ message: `✅ Room ${roomNumber} started by ${username} at ${startTime}` });

    } catch (error) {
        console.error("❌ Start Cleaning Error:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.post("/logs/finish", async (req, res) => {
    const io = req.app.get('io');
    let { roomNumber, username, finishTime, status } = req.body;

    if (!roomNumber || !username) {
        return res.status(400).json({ message: "Missing required fields" });
    }

    roomNumber = parseInt(roomNumber, 10);
    finishTime = finishTime || new Date().toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" });
    status = status || "finished";

    try {
        const log = await CleaningLog.findOne({ roomNumber, finishTime: null });
        
        if (!log) {
            return res.status(400).json({ message: "Log not found or already finished" });
        }

        let previousStatus = log.startTime ? "in_progress" : "available";

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
            return res.status(500).json({ message: "Failed to update cleaning status." });
        }

        // Calculate duration
        let duration = null;
        if (updatedLog.startTime && updatedLog.finishTime) {
            const start = moment.tz(updatedLog.startTime, "MM/DD/YYYY, h:mm:ss A", "Asia/Phnom_Penh");
            const end = moment.tz(updatedLog.finishTime, "MM/DD/YYYY, h:mm:ss A", "Asia/Phnom_Penh");
            const diffMinutes = moment.duration(end.diff(start)).asMinutes();
            duration = `${Math.floor(diffMinutes)} minutes`;
        }

        const updatePayload = { roomNumber: String(roomNumber).padStart(3, "0"), status: "finished", previousStatus };
        console.log("[push] trigger FINISH for room", String(roomNumber).padStart(3, "0"), "by", username);
        console.log("Emitting roomUpdate from /logs/finish:", updatePayload);
        io.emit("roomUpdate", updatePayload);
        // Web Push: Cleaning Finished
        const sendPushFinish = req.app.get("sendPush");
        if (sendPushFinish) {
            try {
                console.log("[push] sending FINISH push for", String(roomNumber).padStart(3, "0"), "by", username);
                await sendPushFinish({
                    title: "Cleaning Finished",
                    body: `Room ${String(roomNumber).padStart(3, "0")} finished by ${username}${duration ? ` (${duration})` : ""}`,
                    tag: `room-${String(roomNumber).padStart(3, "0")}-finished`,
                    data: { roomNumber: String(roomNumber).padStart(3, "0") }
                });
            } catch (e) {
                console.error("[push] FINISH push error:", e?.statusCode || "", e?.message || e);
            }
        }

        res.status(200).json({ message: `Room ${roomNumber} finished by ${username}`, duration });

    } catch (error) {
        console.error("❌ Finish Cleaning Error:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

router.post("/logs/check", async (req, res) => {
    const io = req.app.get('io');
    let { roomNumber, username } = req.body;
    if (!roomNumber || !username) {
        return res.status(400).json({ message: "Room number and username are required" });
    }

    roomNumber = parseInt(roomNumber, 10);
    const checkedTime = new Date().toISOString();

    try {
        const updatedLog = await CleaningLog.findOneAndUpdate(
            { roomNumber, finishTime: { $ne: null }, checkedTime: null },
            { $set: { checkedTime, checkedBy: username, status: "checked" } },
            { new: true }
        );

        if (!updatedLog) {
            return res.status(400).json({ message: "Room not found or already checked." });
        }

        io.emit("roomChecked", { 
            roomNumber: String(roomNumber).padStart(3, "0"), 
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

router.get("/logs", async (req, res) => {
    try {
        const { status: filterStatus, dateFilter } = req.query;

        const now = moment().tz('Asia/Phnom_Penh');
        let startDate = null;
        let endDate = null;

        switch (dateFilter) {
            case 'today':
                startDate = now.clone().startOf('day');
                endDate = startDate.clone().add(1, 'day');
                break;
            case 'yesterday':
                startDate = now.clone().subtract(1, 'day').startOf('day');
                endDate = startDate.clone().add(1, 'day');
                break;
            case 'this_week':
                startDate = now.clone().startOf('week');
                endDate = startDate.clone().add(1, 'week');
                break;
            case 'this_month':
                startDate = now.clone().startOf('month');
                endDate = startDate.clone().add(1, 'month');
                break;
            default:
                break;
        }

        const query = {};
        if (startDate && endDate) {
            query.date = {
                $gte: startDate.toDate(),
                $lt: endDate.toDate()
            };
        }

        const logs = await CleaningLog.find(query)
            .sort({ date: -1, _id: -1 })
            .lean();

        // Keep only the newest log for each room so filters reflect current state.
        const latestLogsMap = new Map();
        logs.forEach(log => {
            const roomStr = String(log.roomNumber).padStart(3, "0");
            if (!latestLogsMap.has(roomStr)) {
                latestLogsMap.set(roomStr, {
                    ...log,
                    roomNumber: roomStr,
                });
            }
        });

        let allRoomsData = allRoomNumbers.map(roomNumber => {
            if (latestLogsMap.has(roomNumber)) {
                return latestLogsMap.get(roomNumber);
            }

            return {
                _id: new mongoose.Types.ObjectId(),
                roomNumber,
                startTime: null,
                startedBy: null,
                finishTime: null,
                finishedBy: null,
                checkedTime: null,
                checkedBy: null,
                dndStatus: false,
                status: "available",
            };
        });

        if (filterStatus && filterStatus !== 'all') {
            allRoomsData = allRoomsData.filter(room => room.status === filterStatus);
        }

        res.json(allRoomsData);
    } catch (error) {
        console.error("Server error fetching logs:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.post("/logs/clear", async (req, res) => {
    const io = req.app.get('io');
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const logCount = await CleaningLog.countDocuments().session(session);
        if (logCount > 0) {
            await CleaningLog.deleteMany({}).session(session);
        }

        const dndReset = await RoomDND.updateMany({}, { $set: { dndStatus: false } }).session(session);
        const dndLogs = await RoomDND.find({}, "roomNumber dndStatus").lean();
        const priorityReset = await RoomPriority.updateMany({}, { $set: { priority: "default" } }).session(session);
        const inspectionCount = await InspectionLog.countDocuments().session(session);
        if (inspectionCount > 0) {
            await InspectionLog.deleteMany({}).session(session);
        }

        await session.commitTransaction();
        session.endSession();

        io.emit("clearLogs");
        io.emit("dndUpdate", { roomNumber: "all", status: "available", dndLogs });
        io.emit("priorityUpdate", { roomNumber: "all", priority: "default" });
        io.emit("resetCheckedRooms");
        io.emit("inspectionLogsCleared");

        allRoomNumbers.forEach(roomNumber => {
            io.emit("resetCleaning", { roomNumber, status: "available" });
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

router.get("/logs/notes", authenticateToken, async (req, res) => {
    try {
        const notes = await RoomNote.find({});
        res.status(200).json(notes);
    } catch (error) {
        console.error("Error fetching room notes:", error);
        res.status(500).json({ message: "Failed to fetch room notes" });
    }
});

router.post("/logs/notes", authenticateToken, async (req, res) => {
    const { roomNumber, notes } = req.body;
    const { username } = req.user;
    const io = req.app.get('io');

    try {
        const updatedNote = await RoomNote.findOneAndUpdate(
            { roomNumber },
            { ...notes, lastUpdatedBy: username },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        io.emit("noteUpdate", { roomNumber, notes: updatedNote });
        res.status(200).json(updatedNote);
    } catch (error) {
        console.error("Error updating room note:", error);
        res.status(500).json({ message: "Failed to update room note" });
    }
});

module.exports = router;
