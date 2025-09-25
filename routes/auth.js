const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "No token provided" });
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decodedToken) => {
        if (err) return res.status(403).json({ message: "Invalid token" });

        try {
            const user = await User.findById(decodedToken.id);
            console.log("authenticateToken: decodedToken.id", decodedToken.id);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }
            req.user = user;
            console.log("authenticateToken: req.user set to", req.user);
            next();
        } catch (dbError) {
            console.error("Error fetching user in authenticateToken:", dbError);
            res.status(500).json({ message: "Internal server error during authentication" });
        }
    });
}

router.post("/auth/signup", async (req, res) => {
    const { username, password } = req.body;
    try {
        if (await User.findOne({ username })) {
            return res.status(400).json({ message: "User already exists." });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await new User({ username, password: hashedPassword }).save();
        res.status(201).json({ message: "User registered successfully!" });
    } catch (error) {
        console.error("❌ Signup Error:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.post("/auth/login", async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ message: "Missing username or password" });
        }

        const user = await User.findOne({ username });
        if (!user) {
            console.warn(`❌ Login Failed: User not found - ${username}`);
            return res.status(401).json({ message: "Invalid username or password" });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            console.warn(`❌ Login Failed: Incorrect password for ${username}`);
            return res.status(401).json({ message: "Invalid username or password" });
        }

        const token = jwt.sign({ username: user.username, id: user._id }, process.env.JWT_SECRET, { expiresIn: "16h" });
        const refreshToken = jwt.sign({ username: user.username }, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });

        user.refreshToken = refreshToken;
        await user.save();

        console.log(`✅ Login successful for: ${username}`);
        res.json({ message: "Login successful", token, refreshToken, username });
    } catch (error) {
        console.error("❌ Server Error on Login:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

router.post("/auth/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    try {
        if (!refreshToken) return res.status(401).json({ message: "No refresh token provided" });

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const user = await User.findOne({ username: decoded.username, refreshToken });

        if (!user) return res.status(403).json({ message: "Invalid refresh token" });

        const newAccessToken = jwt.sign({ username: user.username, id: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
        const newRefreshToken = jwt.sign({ username: user.username }, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });

        user.refreshToken = newRefreshToken;
        await user.save();

        res.json({ token: newAccessToken, refreshToken: newRefreshToken });
    } catch (error) {
        console.error("❌ Refresh Token Error:", error);
        res.status(403).json({ message: "Invalid refresh token" });
    }
});

router.post("/auth/logout", async (req, res) => {
    const { username } = req.body;
    try {
        await User.updateOne({ username }, { $unset: { refreshToken: "" } });
        res.json({ message: "✅ Logged out successfully." });
    } catch (error) {
        console.error("❌ Logout Error:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

router.get("/auth/validate", (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ valid: false, message: "No token provided" });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ valid: false, message: "Invalid token" });
        res.json({ valid: true, user: decoded });
    });
});

module.exports = { router, authenticateToken };