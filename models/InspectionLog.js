const mongoose = require("mongoose");

const InspectionLogSchema = new mongoose.Schema({
    roomNumber: String,
    items: { type: Map, of: String },
    overallScore: Number, // Added overallScore
    updatedBy: String,
    updatedAt: Date
});

module.exports = mongoose.models.InspectionLog || mongoose.model('InspectionLog', InspectionLogSchema);