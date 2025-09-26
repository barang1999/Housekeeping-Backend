const mongoose = require("mongoose");
const moment = require("moment-timezone");

const getTodayInPhnomPenh = () => moment().tz("Asia/Phnom_Penh").startOf("day").toDate();

const InspectionLogSchema = new mongoose.Schema({
    roomNumber: { type: String, required: true },
    date: { type: Date, required: true, default: getTodayInPhnomPenh },
    items: { type: Map, of: String },
    overallScore: Number,
    updatedBy: String,
    updatedAt: Date
}, { timestamps: true });

InspectionLogSchema.index(
    { roomNumber: 1, date: 1 },
    { unique: true, partialFilterExpression: { date: { $exists: true } } }
);

module.exports = mongoose.models.InspectionLog || mongoose.model('InspectionLog', InspectionLogSchema);
    