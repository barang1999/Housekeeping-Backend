const express = require("express");
const axios = require("axios");

const router = express.Router();

async function sendMessageToTelegram(message) {
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
    } catch (error) {
        console.error("❌ Error sending Telegram message:", error);
    }
}

router.post("/send-telegram", async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        await sendMessageToTelegram(message);
        return res.json({ success: true, message: "Message sent to Telegram" });
    } catch (error) {
        return res.status(500).json({ error: "Telegram API request failed" });
    }
});

module.exports = router;