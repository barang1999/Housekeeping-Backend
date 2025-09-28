const mongoose = require("mongoose");

const roomDNDSchema = new mongoose.Schema({
    roomNumber: { type: Number, required: true },
    dndStatus: { type: Boolean, default: false },
    dndSetBy: { type: String },
    dndSetAt: { type: Date },
    date: { type: Date, default: Date.now }
});

module.exports = mongoose.models.RoomDND || mongoose.model("RoomDND", roomDNDSchema);