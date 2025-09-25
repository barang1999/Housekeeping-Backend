const mongoose = require("mongoose");

const roomNoteSchema = new mongoose.Schema({
    roomNumber: { type: String, required: true, unique: true },
    tags: [{ type: String }],
    afterTime: { type: String },
    note: { type: String },
    lastUpdatedBy: { type: String, required: true },
}, { timestamps: true });

const RoomNote = mongoose.models.RoomNote || mongoose.model("RoomNote", roomNoteSchema);

module.exports = RoomNote;
