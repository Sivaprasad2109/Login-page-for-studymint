require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ✅ Load Firebase service account
let serviceAccountPath = path.join(__dirname, "serviceaccountkey.json");
if (!fs.existsSync(serviceAccountPath)) {
  throw new Error("❌ Firebase service account key file not found.");
}
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Config
const MIN_WITHDRAWAL = 40; // Change here for withdrawal limit

// Functions
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateUserID() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ✅ Coin History API
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
app.post("/reject-withdrawal", async (req, res) => {
  const { requestId } = req.body;
  
  try {
    const requestRef = db.collection("withdrawRequests").doc(requestId);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) return res.status(404).json({ message: "Request not found" });

    const { email, coins } = requestDoc.data();

    // 1. Update request status
    await requestRef.update({ status: "rejected" });

    // 2. Return coins to user
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      await userRef.update({ coins: userData.coins + coins });
    }

    // 3. Add coin history
    await db.collection("coinHistory").add({
      email,
      type: "Withdrawal Rejected - Coins Returned",
      coins,
      date: new Date().toISOString()
    });

    res.json({ message: "Withdrawal rejected and coins returned" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});
app.post("/admin-login", (req,res)=>{
  const { username, password } = req.body;
  if(username===process.env.ADMIN_USER && password===process.env.ADMIN_PASS){
    return res.json({ success:true });
  }
  res.status(401).json({ success:false });
});


// ✅ Send OTP
app.post("/send-otp", async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const otp = generateOTP();
  const createdAt = Date.now();

  try {
    await db.collection("otps").doc(email).set({ otp, createdAt });

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: email,
      subject: "OTP Verification",
      text: `Your OTP is: ${otp}. It will expire in 5 minutes.`
    });

    console.log(`✅ OTP sent to ${email}`);
    res.status(200).json({ message: "OTP sent successfully" });

  } catch (error) {
    console.error("❌ Error sending OTP:", error);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

// ✅ Verify OTP
app.post("/verify-otp", async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const otp = String(req.body.otp);

  try {
    const otpDoc = await db.collection("otps").doc(email).get();
    if (!otpDoc.exists) return res.status(400).json({ message: "OTP not found or expired" });

    const { otp: storedOtp, createdAt } = otpDoc.data();
    if (Date.now() - createdAt > 300000) {
      await db.collection("otps").doc(email).delete();
      return res.status(400).json({ message: "OTP expired" });
    }

    if (String(storedOtp) !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      const data = userDoc.data();
      await db.collection("otps").doc(email).delete();
      return res.json({ message: "Email already verified", userID: data.userID, coins: data.coins });
    }

    const userID = generateUserID();
    await userRef.set({ email, userID, coins: 50, createdAt: new Date().toISOString() });

    await db.collection("coinHistory").add({
      email, type: "Signup Bonus", coins: 50, date: new Date().toISOString()
    });

    await db.collection("otps").doc(email).delete();

    res.json({ message: "Email verified", userID, coins: 50 });

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
    if (snapshot.empty) return res.status(404).json({ message: "User not found" });
    const userData = snapshot.docs[0].data();
    res.json({ email: userData.email, userID: userData.userID, coins: userData.coins });
  } catch (err) {
    res.status(500).json({ message: "Server error fetching user" });
  }
});

// ✅ Redeem Coins
app.post("/redeem-coins", async (req, res) => {
  const { email, userID, coins, upi } = req.body;

  if (!email || !userID || !coins || !upi) {
    return res.status(400).json({ success: false, message: "All fields are required" });
  }
  if (coins < MIN_WITHDRAWAL) {
    return res.status(400).json({ success: false, message: `Minimum withdrawal is ${MIN_WITHDRAWAL} coins` });
  }

  try {
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found" });

    const userData = userDoc.data();
    if (userData.coins < coins) {
      return res.status(400).json({ success: false, message: "Not enough coins" });
    }

    // Deduct coins
    await userRef.update({ coins: userData.coins - coins });

    // Store withdraw request
    const requestRef = await db.collection("withdrawRequests").add({
      email, userID, coins, upi, status: "pending", date: new Date().toISOString()
    });

    // Add to history
    await db.collection("coinHistory").add({
      email, type: "Redeem Request", coins: -coins, date: new Date().toISOString()
    });

    res.json({ success: true, message: "Redeem request submitted successfully" });

  } catch (error) {
    console.error("❌ Error redeeming coins:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Admin: Refund coins if request rejected
app.post("/refund-coins", async (req, res) => {
  const { requestId } = req.body;
  try {
    const requestDoc = await db.collection("withdrawRequests").doc(requestId).get();
    if (!requestDoc.exists) return res.status(404).json({ success: false, message: "Request not found" });

    const { email, coins } = requestDoc.data();
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found" });

    // Refund coins
    await userRef.update({ coins: userDoc.data().coins + coins });

    // Update request status
    await db.collection("withdrawRequests").doc(requestId).update({ status: "rejected" });

    // Add refund to history
    await db.collection("coinHistory").add({
      email, type: "Refund", coins: coins, date: new Date().toISOString()
    });

    res.json({ success: true, message: "Coins refunded successfully" });

  } catch (error) {
    console.error("❌ Error refunding coins:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Start Server
app.listen(3000, () => {
  console.log("https://login-page-for-studymint-1.onrender.com/");
});



