const express = require("express");
const { router: authRouter } = require("./auth");
const logsRouter = require("./logs");
const userRouter = require("./user");
const telegramRouter = require("./telegram");

const router = express.Router();

router.use(authRouter);
router.use(logsRouter);
router.use(userRouter);
router.use(telegramRouter);

router.get("/", (req, res) => {
    res.send("Housekeeping Management API is Running 🚀");
});

module.exports = router;