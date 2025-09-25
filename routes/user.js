const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const sharp = require('sharp');
const moment = require("moment-timezone");

const User = require("../models/User");
const ScoreLog = require("../models/ScoreLog");
const CleaningLog = require("../models/CleaningLog");
const { authenticateToken } = require("./auth");

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.post("/user/update-profile", authenticateToken, upload.single("profileImage"), async (req, res) => {
  try {
    const username = req.user.username;
    const { phone, position, password } = req.body;

    let base64Image = null;
    if (req.file) {
      const compressed = await sharp(req.file.buffer)
        .resize(80, 80)
        .jpeg({ quality: 60 })
        .toBuffer();

      base64Image = `data:image/jpeg;base64,${compressed.toString("base64")}`;
    }

    const updateFields = {};
    if (phone) updateFields.phone = phone;
    if (position) updateFields.position = position;
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      updateFields.password = hashed;
    }
    if (base64Image) updateFields.profileImage = base64Image;

    await User.updateOne({ username }, { $set: updateFields });

    res.json({ success: true, message: "Profile updated" });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ success: false, message: "Update failed" });
  }
});

router.get("/user/profile", authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const { phone = "", position = "", profileImage = "", username: name } = user;

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

router.post("/score/reward-fastest", authenticateToken, async (req, res) => {
  const cambodiaNow = moment.tz("Asia/Phnom_Penh").toDate();

  const startOfDay = moment(cambodiaNow).startOf("day").toDate();
  const endOfDay = moment(cambodiaNow).endOf("day").toDate();

  const logs = await CleaningLog.find({
    startTime: { $ne: null },
    finishTime: { $ne: null }
  });

  if (!logs || logs.length === 0) {
    return res.status(404).json({ message: "No completed cleaning logs." });
  }

  const userStats = {};
  logs.forEach(log => {
    const startTime = new Date(log.startTime);
    const finishTime = new Date(log.finishTime);
    const duration = (finishTime - startTime) / 60000;

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

router.post("/score/add", authenticateToken, async (req, res) => {
  const username = req.user.username;
  const cambodiaNow = moment.tz("Asia/Phnom_Penh").toDate();

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

router.get("/score/leaderboard", authenticateToken, async (req, res) => {
  try {
    const leaderboard = await ScoreLog.aggregate([
      {
        $match: { isFastest: true } 
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

router.get("/user/all", authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, "username phone position profileImage");
    res.json(users);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ message: "Failed to retrieve users" });
  }
});

module.exports = router;