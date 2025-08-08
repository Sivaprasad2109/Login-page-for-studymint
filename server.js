require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ✅ Auto-detect service account file (case-insensitive safety)
let serviceAccountPath = path.join(__dirname, "serviceaccountkey.json");
if (!fs.existsSync(serviceAccountPath)) {
  serviceAccountPath = path.join(__dirname, "serviceaccountkey.json");
}
if (!fs.existsSync(serviceAccountPath)) {
  throw new Error("❌ Firebase service account key file not found. Please add it as a Secret File in Render.");
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateUserID() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ✅ Fetch Coin History
app.get("/coin-history", async (req, res) => {
  const { email } = req.query;

  try {
    const snapshot = await db.collection("coinHistory").where("email", "==", email).get();

    if (snapshot.empty) return res.json({ history: [] });

    const history = snapshot.docs.map(doc => doc.data());
    res.json({ history });
  } catch (error) {
    console.error("❌ Error fetching coin history:", error);
    res.status(500).json({ message: "Error fetching coin history" });
  }
});

// ✅ Send OTP (Firestore + Expiry)
app.post("/send-otp", async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const otp = generateOTP();
  const createdAt = Date.now();

  try {
    // Store OTP in Firestore
    await db.collection("otps").doc(email).set({
      otp,
      createdAt
    });

    // Send email
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: email,
      subject: "OTP Verification",
      text: `Your OTP is: ${otp}. It will expire in 5 minutes.`,
    });

    console.log(`✅ OTP sent to ${email}`);
    res.status(200).json({ message: "OTP sent successfully" });

  } catch (error) {
    console.error("❌ Error sending OTP:", error);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

// ✅ Verify OTP (with expiry check)
app.post("/verify-otp", async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const otp = String(req.body.otp);

  try {
    // Get OTP data from Firestore
    const otpDoc = await db.collection("otps").doc(email).get();

    if (!otpDoc.exists) {
      return res.status(400).json({ message: "OTP not found or expired" });
    }

    const { otp: storedOtp, createdAt } = otpDoc.data();

    // Check expiry (5 mins)
    if (Date.now() - createdAt > 300000) {
      await db.collection("otps").doc(email).delete();
      return res.status(400).json({ message: "OTP expired" });
    }

    // Validate OTP
    if (String(storedOtp) !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // ✅ OTP correct — check if user exists
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      const data = userDoc.data();
      await db.collection("otps").doc(email).delete(); // delete OTP
      return res.json({
        message: "Email already verified",
        userID: data.userID,
        coins: data.coins
      });
    }

    // New user — create entry
    const userID = generateUserID();
    await userRef.set({
      email,
      userID,
      coins: 50,
      createdAt: new Date().toISOString()
    });

    // Add coin history
    await db.collection("coinHistory").add({
      email,
      type: "Signup Bonus",
      coins: 50,
      date: new Date().toISOString()
    });

    await db.collection("otps").doc(email).delete(); // delete OTP

    res.json({
      message: "Email verified",
      userID,
      coins: 50
    });

  } catch (error) {
    console.error("❌ Error verifying OTP:", error);
    res.status(500).json({ message: "Error verifying email" });
  }
});

// ✅ Get user data
app.get("/get-user-data", async (req, res) => {
  const { email } = req.query;

  try {
    const snapshot = await db.collection("users").where("email", "==", email).get();

    if (snapshot.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = snapshot.docs[0].data();
    res.json({
      email: userData.email,
      userID: userData.userID,
      coins: userData.coins
    });
  } catch (err) {
    res.status(500).json({ message: "Server error fetching user" });
  }
});

// ✅ Start server
app.listen(3000, () => {
  console.log("✅ Server running at http://localhost:3000");
});
