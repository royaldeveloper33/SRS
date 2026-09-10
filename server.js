const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const Database = require("better-sqlite3");

const app = express();

const PORT = 5000;

// =====================================================
// DATABASE
// =====================================================

const db = new Database("srs_ai.db");

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

console.log("Database connected successfully.");


// =====================================================
// MIDDLEWARE
// =====================================================

app.use(express.json());

app.use(
    cors({
        origin: function (origin, callback) {
            const allowedOrigins = [
                "http://localhost:5500",
                "http://127.0.0.1:5500"
            ];

            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error("Not allowed by CORS"));
            }
        },
        credentials: true
    })
);
app.use(
    session({
        secret: "srs-ai-secret-key-change-this-later",
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000
        }
    })
);


// =====================================================
// HOME / TEST ROUTE
// =====================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "SRS AI Backend is running!"
    });
});


// =====================================================
// REGISTER
// =====================================================

app.post("/api/register", async (req, res) => {
    try {
        const { fullName, email, password } = req.body;

        // Check required fields
        if (!fullName || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all fields."
            });
        }

        // Clean email
        const cleanEmail = email.trim().toLowerCase();

        // Check password length
        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters."
            });
        }

        // Check if email already exists
        const existingUser = db
            .prepare("SELECT id FROM users WHERE email = ?")
            .get(cleanEmail);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists."
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const result = db
            .prepare(`
                INSERT INTO users (full_name, email, password)
                VALUES (?, ?, ?)
            `)
            .run(fullName.trim(), cleanEmail, hashedPassword);

        // Create login session
        req.session.user = {
            id: result.lastInsertRowid,
            fullName: fullName.trim(),
            email: cleanEmail
        };

        return res.status(201).json({
            success: true,
            message: "Account created successfully.",
            user: req.session.user
        });

    } catch (error) {
        console.error("Register error:", error);

        return res.status(500).json({
            success: false,
            message: "Server error while creating account."
        });
    }
});


// =====================================================
// LOGIN
// =====================================================

app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check fields
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Please enter your email and password."
            });
        }

        // Clean email
        const cleanEmail = email.trim().toLowerCase();

        // Find user
        const user = db
            .prepare(`
                SELECT id, full_name, email, password
                FROM users
                WHERE email = ?
            `)
            .get(cleanEmail);

        // User doesn't exist
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        // Compare password
        const passwordMatch = await bcrypt.compare(
            password,
            user.password
        );

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        // Create session
        req.session.user = {
            id: user.id,
            fullName: user.full_name,
            email: user.email
        };

        return res.json({
            success: true,
            message: "Login successful.",
            user: req.session.user
        });

    } catch (error) {
        console.error("Login error:", error);

        return res.status(500).json({
            success: false,
            message: "Server error while logging in."
        });
    }
});


// =====================================================
// CHECK CURRENT USER
// =====================================================

app.get("/api/me", (req, res) => {

    if (!req.session.user) {
        return res.status(401).json({
            success: false,
            message: "Not logged in."
        });
    }

    res.json({
        success: true,
        user: req.session.user
    });
});


// =====================================================
// LOGOUT
// =====================================================

app.post("/api/logout", (req, res) => {

    req.session.destroy((error) => {

        if (error) {
            return res.status(500).json({
                success: false,
                message: "Could not log out."
            });
        }

        res.clearCookie("connect.sid");

        res.json({
            success: true,
            message: "Logged out successfully."
        });
    });
});


// =====================================================
// FORGOT PASSWORD
// =====================================================

app.post("/api/forgot-password", (req, res) => {

    const { email } = req.body;

    if (!email) {
        return res.status(400).json({
            success: false,
            message: "Please enter your email."
        });
    }

    // For now, we don't actually send an email.
    // Email password reset can be added later.

    res.json({
        success: true,
        message: "If an account exists with this email, password reset instructions will be sent."
    });
});


// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {

    console.log("------------------------------------");
    console.log("SRS AI Backend Started");
    console.log(`Server: http://localhost:${PORT}`);
    console.log("------------------------------------");

});