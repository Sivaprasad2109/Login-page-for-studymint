const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const users = {}; // Temporary in-memory storage

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateUserID() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP
app.post("/send-otp", (req, res) => {
  const { email } = req.body;
  const otp = generateOTP();

  users[email] = {
    otp,
    timestamp: Date.now(), // store time of OTP generation
    userID: users[email]?.userID || null // preserve existing userID if already verified
  };

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const mailOptions = {
    from: "your_email@gmail.com",
    to: email,
    subject: "OTP Verification",
    text: `Your OTP is: ${otp}\n\n"Knowledge increases by sharing but not by saving." – StudyMint`,

  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) return res.status(500).json({ message: "Failed to send OTP" });
    res.json({ message: "OTP sent successfully" });
  });
});

// Verify OTP
app.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  const userData = users[email];

  if (!userData) {
    return res.status(400).json({ message: "No OTP sent for this email" });
  }

  const currentTime = Date.now();
  const otpExpiry = 5 * 60 * 1000; // 5 minutes in milliseconds

  if (currentTime - userData.timestamp > otpExpiry) {
    return res.status(400).json({ message: "OTP expired. Please request a new one." });
  }

  if (userData.otp !== otp) {
    return res.status(400).json({ message: "Invalid OTP" });
  }

  // Prevent multiple user IDs for the same email
  if (userData.userID) {
    return res.json({ message: "Email already verified", userID: userData.userID });
  }

  const userID = generateUserID();
  users[email].userID = userID;

  res.json({ message: "Email verified", userID });
});

app.listen(3000, () => {
  console.log("✅ Server running at http://localhost:3000");
});
