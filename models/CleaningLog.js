const mongoose = require("mongoose");

const logSchema = new mongoose.Schema({
    roomNumber: { type: Number, required: true },
    date: { type: Date, default: Date.now, index: true },
    startTime: { type: String, default: null },
    startedBy: { type: String, default: null },
    finishTime: { type: String, default: null },
    finishedBy: { type: String, default: null },
    checkedTime: { type: String, default: null },
    checkedBy: { type: String, default: null },
    dndStatus: { type: Boolean, default: false },
    status: { type: String, default: "available" }
});

logSchema.index({ roomNumber: 1, date: -1 });

const CleaningLog = mongoose.models.CleaningLog || mongoose.model("CleaningLog", logSchema);

module.exports = CleaningLog;