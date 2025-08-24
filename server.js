require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

// ✅ Firebase Service Account
let serviceAccountPath = path.join(__dirname, "serviceaccountkey.json");
if (!fs.existsSync(serviceAccountPath)) {
  throw new Error("❌ Firebase service account key file not found.");
}
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: serviceAccount.project_id + ".appspot.com"
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Config
const MIN_WITHDRAWAL = 40;
const DOWNLOAD_COST = 10;

// ✅ Multer (for file upload)
const upload = multer({ storage: multer.memoryStorage() });

// ========== EXISTING ROUTES (withdraw, OTP, redeem, etc.) ==========
// keep your OTP, verify, withdraw, reject, approve routes as they are...

// ✅ Upload File (Admin only)
app.post("/upload-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const fileName = Date.now() + "-" + req.file.originalname;
    const file = bucket.file(fileName);

    // Upload to Firebase Storage
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    // Make file public
    await file.makePublic();
    const fileUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    // Save metadata in Firestore
    await db.collection("files").add({
      name: req.file.originalname,
      url: fileUrl,
      uploadedAt: new Date().toISOString()
    });

    res.json({ success: true, message: "File uploaded successfully", fileUrl });
  } catch (error) {
    console.error("❌ File upload error:", error);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

// ✅ Get Available Files
app.get("/get-files", async (req, res) => {
  try {
    const snapshot = await db.collection("files").get();
    if (snapshot.empty) return res.json([]);

    const files = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(files);
  } catch (error) {
    console.error("❌ Error fetching files:", error);
    res.status(500).json({ message: "Error fetching files" });
  }
});

// ✅ Download File (Deduct Coins)
app.post("/download-file", async (req, res) => {
  const { email, fileId } = req.body;

  try {
    // Get file
    const fileDoc = await db.collection("files").doc(fileId).get();
    if (!fileDoc.exists) return res.status(404).json({ success: false, message: "File not found" });

    const fileData = fileDoc.data();

    // Check user balance
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found" });

    const userData = userDoc.data();
    if (userData.coins < DOWNLOAD_COST) {
      return res.status(400).json({ success: false, message: "Not enough coins" });
    }

    // Deduct coins
    await userRef.update({ coins: userData.coins - DOWNLOAD_COST });

    // Add to coin history
    await db.collection("coinHistory").add({
      email,
      type: "File Download",
      coins: -DOWNLOAD_COST,
      date: new Date().toISOString()
    });

    res.json({ success: true, fileUrl: fileData.url });
  } catch (error) {
    console.error("❌ Error in download:", error);
    res.status(500).json({ success: false, message: "Download failed" });
  }
});

// ✅ Start Server
app.listen(3000, () => {
  console.log("✅ Server running on http://localhost:3000");
});
