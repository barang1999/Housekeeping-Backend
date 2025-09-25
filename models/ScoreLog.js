const mongoose = require("mongoose");

const scoreLogSchema = new mongoose.Schema({
  username: String,
  date: Date,
  score: Number,
  isFastest: Boolean,
});

module.exports = mongoose.models.ScoreLog || mongoose.model('ScoreLog', scoreLogSchema);