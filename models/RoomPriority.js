const mongoose = require("mongoose");

const prioritySchema = new mongoose.Schema({
    roomNumber: { type: String, required: true, unique: true },
    priority: { type: String, default: "default" },
    allowCleaningTime: { type: String, default: null } 
});

module.exports = mongoose.models.RoomPriority || mongoose.model("RoomPriority", prioritySchema);