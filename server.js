require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
// Cloudflare R2 (S3 compatible)
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");




const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});



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

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// ✅ Config
const MIN_WITHDRAWAL = 40; // Change here for withdrawal limit
const DOWNLOAD_COST = 10; // SM Coins cost per download

// Sample downloadable files (You can modify these URLs to your actual files)
const DOWNLOADABLE_FILES = [
  {
    id: "file1",
    name: "Study Guide - Mathematics.pdf",
    url: "https://example.com/files/math-guide.pdf" // Replace with your actual file URL
  },
  {
    id: "file2", 
    name: "Physics Formula Sheet.pdf",
    url: "https://example.com/files/physics-formulas.pdf" // Replace with your actual file URL
  },
  {
    id: "file3",
    name: "Chemistry Notes.pdf", 
    url: "https://example.com/files/chemistry-notes.pdf" // Replace with your actual file URL
  }
];

// Utility Functions
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateUserID() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ====================== USER ROUTES ======================

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

// ✅ Get Available Downloads
app.get("/get-downloads", async (req, res) => {
  try {
    // Get files from Firebase (uploaded by admin) and combine with default files
    const uploadedFilesSnapshot = await db.collection("uploadedFiles").get();
    const uploadedFiles = uploadedFilesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Combine default files with uploaded files
    const allFiles = [...DOWNLOADABLE_FILES, ...uploadedFiles];
    
    res.json({ files: allFiles });
  } catch (error) {
    console.error("❌ Error fetching downloads:", error);
    res.status(500).json({ message: "Error fetching downloads" });
  }
});

// ✅ Coin History
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

    await userRef.update({ coins: userData.coins - coins });

    await db.collection("withdrawRequests").add({
      email, userID, coins, upi, status: "pending", date: new Date().toISOString()
    });

    await db.collection("coinHistory").add({
      email, type: "Redeem Request", coins: -coins, date: new Date().toISOString()
    });

    res.json({ success: true, message: "Redeem request submitted successfully" });

  } catch (error) {
    console.error("❌ Error redeeming coins:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ====================== ADMIN ROUTES ======================

// ✅ Admin Login
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: "Invalid admin credentials" });
});

// ✅ Get Pending Withdraw Requests
app.get("/get-withdraw-requests", async (req, res) => {
  try {
    const snapshot = await db.collection("withdrawRequests")
      .where("status", "==", "pending")
      .get();

    if (snapshot.empty) return res.json([]);

    const requests = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(requests);
  } catch (error) {
    console.error("❌ Error fetching withdrawal requests:", error);
    res.status(500).json({ message: "Error fetching withdrawal requests" });
  }
});

// ✅ Approve Withdrawal
app.post("/approve-withdrawal", async (req, res) => {
  const { requestId } = req.body;

  try {
    await db.collection("withdrawRequests").doc(requestId).update({
      status: "approved",
      approvedAt: new Date().toISOString()
    });

    res.json({ message: "Withdrawal approved successfully" });
  } catch (error) {
    console.error("❌ Error approving withdrawal:", error);
    res.status(500).json({ message: "Error approving withdrawal" });
  }
});

// ✅ Reject Withdrawal & Refund Coins
app.post("/reject-withdrawal", async (req, res) => {
  const { requestId, email, coins } = req.body;

  try {
    await db.collection("withdrawRequests").doc(requestId).update({
      status: "rejected",
      rejectedAt: new Date().toISOString()
    });

    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
      const currentCoins = userDoc.data().coins || 0;
      await userRef.update({
        coins: currentCoins + coins
      });

      await db.collection("coinHistory").add({
        email,
        type: "Refund - Withdrawal Rejected",
        coins,
        date: new Date().toISOString()
      });
    }

    res.json({ message: "Withdrawal rejected and coins refunded" });
  } catch (error) {
    console.error("❌ Error rejecting withdrawal:", error);
    res.status(500).json({ message: "Error rejecting withdrawal" });
  }
});

// ✅ Admin Upload File to Cloudflare R2
app.post("/admin-upload-file", upload.single('file'), async (req, res) => {
  const { fileName } = req.body;
  const file = req.file;

  if (!fileName || !file) {
    return res.status(400).json({ success: false, message: "File name and file are required" });
  }

  try {
    // Create unique key for R2
    const key = `${Date.now()}_${file.originalname}`;

    // Upload to R2
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(file.path),
      ContentType: file.mimetype
    }));

    // Save file metadata in Firestore (not the local URL anymore)
    const fileData = {
      name: fileName,
      r2Key: key,
      originalName: file.originalname,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: "admin"
    };

    const docRef = await db.collection("uploadedFiles").add(fileData);

    console.log(`✅ Admin uploaded new file to R2: ${fileName}`);

    res.json({
      success: true,
      message: "File uploaded to Cloudflare R2 successfully!",
      fileId: docRef.id
    });

 } catch (error) {
  console.error("❌ Error uploading to R2:", error);
  res.status(500).json({ 
    success: false, 
    message: "Error uploading to R2", 
    error: error.message,
    details: error.$metadata || null
  });
}


});

// ✅ Download route with coin deduction + watermark (logo + email) -> streams watermarked PDF
app.post("/download-file", async (req, res) => {
  try {
    const { fileId, email } = req.body;
    if (!fileId || !email) {
      return res.status(400).json({ success: false, message: "Missing fileId or email" });
    }

    // Get file metadata
    const fileDocRef = db.collection("uploadedFiles").doc(fileId);
    const fileDoc = await fileDocRef.get();
    if (!fileDoc.exists) {
      return res.status(404).json({ success: false, message: "File not found" });
    }
    const fileData = fileDoc.data();

    // Use a deterministic doc id for download history to prevent double-charging
    const downloadDocRef = db.collection("downloadHistory").doc(`${email}_${fileId}`);
    const userRef = db.collection("users").doc(email);

    // Transaction: check user, check existing download, deduct if needed, record history
    const txResult = await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error("USER_NOT_FOUND");

      const downloadSnap = await t.get(downloadDocRef);
      if (downloadSnap.exists) {
        // Already downloaded previously — no deduction
        return { deducted: false, newCoins: userSnap.data().coins || 0 };
      }

      const currentCoins = userSnap.data().coins || 0;
      if (currentCoins < DOWNLOAD_COST) throw new Error("INSUFFICIENT_COINS");

      const newCoins = currentCoins - DOWNLOAD_COST;
      t.update(userRef, { coins: newCoins });

      // set download record
      t.set(downloadDocRef, {
        email,
        fileId,
        fileName: fileData.name || "unknown",
        coinsDeducted: DOWNLOAD_COST,
        date: new Date().toISOString()
      });

      // set coin history
      const coinHistRef = db.collection("coinHistory").doc();
      t.set(coinHistRef, {
        email,
        type: "File Download",
        coins: -DOWNLOAD_COST,
        fileId,
        date: new Date().toISOString()
      });

      return { deducted: true, newCoins };
    });

    // If transaction succeeded, proceed to fetch file from R2 and watermark it.
    // (If tx threw USER_NOT_FOUND or INSUFFICIENT_COINS it would have been caught below.)
    // Download file from R2
    const getCmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileData.r2Key,
    });
    const r2Response = await r2.send(getCmd);

    // Convert stream to buffer (streamToBuffer must exist in your file)
    const pdfBytes = await streamToBuffer(r2Response.Body);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();

    // Embed logo if exists
    let logoImage = null;
    try {
      const logoPath = path.join(__dirname, "studymint-logo.png"); // adjust path if needed
      if (fs.existsSync(logoPath)) {
        const logoBytes = fs.readFileSync(logoPath);
        logoImage = await pdfDoc.embedPng(logoBytes);
      } else {
        console.warn("⚠️ studymint-logo.png not found at", logoPath);
      }
    } catch (err) {
      console.warn("⚠️ Error embedding logo:", err.message || err);
    }

    // Embed font for email footer
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Draw on each page: logo (center) and email (bottom)
    pages.forEach((page) => {
      const { width, height } = page.getSize();

      if (logoImage) {
        const pngDims = logoImage.scale(0.22); // tweak scale as needed
        page.drawImage(logoImage, {
          x: width / 2 - pngDims.width / 2,
          y: height / 2 - pngDims.height / 2,
          width: pngDims.width,
          height: pngDims.height,
          opacity: 0.28,
        });
      }

      // user email footer
      page.drawText(`Downloaded by: ${email}`, {
        x: 40,
        y: 30,
        size: 10,
        font,
        color: rgb(0.45, 0.45, 0.45),
        opacity: 1,
      });
    });

    const watermarkedPdfBytes = await pdfDoc.save();

    // Return the watermarked PDF as download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileData.name || "download"}.pdf"`);
    return res.send(Buffer.from(watermarkedPdfBytes));
  } catch (err) {
    console.error("❌ Error downloading file:", err);

    // Friendly errors for common transaction failure cases
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (err.message === "INSUFFICIENT_COINS") {
      return res.status(400).json({ success: false, message: `Insufficient coins. You need at least ${DOWNLOAD_COST} SM coins.` });
    }

    return res.status(500).json({ success: false, message: "Error downloading file" });
  }
});





// Utility: convert R2 stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ====================== START SERVER ======================
app.listen(3000, () => {
  console.log("http://localhost:3000");
});
