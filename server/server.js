const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const users = {}; // Temporary storage

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
  users[email] = { otp };

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
    text: `Your OTP is: ${otp}`,
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) return res.status(500).json({ message: "Failed to send OTP" });
    res.json({ message: "OTP sent successfully" });
  });
});

// Verify OTP
app.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (users[email]?.otp === otp) {
    const userID = generateUserID();
    users[email].userID = userID;
    res.json({ message: "Email verified", userID });
  } else {
    res.status(400).json({ message: "Invalid OTP" });
  }
});

app.listen(3000, () => {
  console.log("✅ Server running at http://localhost:3000");
});
