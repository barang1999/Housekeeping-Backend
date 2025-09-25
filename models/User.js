const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String },
    refreshToken: { type: String },
    phone: String,
    position: String,
    profileImage: String,
    score: { type: Number, default: 0 },
    lastUpdated: Date
});

module.exports = mongoose.models.User || mongoose.model("User", userSchema);