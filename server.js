require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, StandardFonts, degrees } = require("pdf-lib");
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
// ✅ Load Firebase service account from environment variable (base64)
// ✅ Load Firebase service account from environment variable (base64)
let serviceAccount = null; // Initialize to null
let db = null; // Initialize db to null

if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    serviceAccount = JSON.parse(json);
  } catch(e) {
    console.error("❌ ERROR PARSING FIREBASE JSON (Base64): Check variable for whitespace/format errors.", e.message);
  }
} else {
  // fallback for local dev
  let serviceAccountPath = path.join(__dirname, "serviceaccountkey.json");
  if (!fs.existsSync(serviceAccountPath)) {
    // CRITICAL FIX: Changed 'throw new Error' to 'console.warn'
    console.warn("❌ WARNING: Firebase service account key not found. Set FIREBASE_SERVICE_ACCOUNT_BASE64 in env vars.");
  } else {
    serviceAccount = require(serviceAccountPath);
  }
}

// Initialize Firebase only if we successfully loaded the service account data
if (serviceAccount) {
    try {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore(); // Define db here
    } catch(e) {
        // CRITICAL FIX: Catch initialization errors
        console.error("❌ ERROR INITIALIZING FIREBASE ADMIN SDK: Credentials likely rejected or SDK initialized twice.", e.message);
    }
}
// End of Firebase setup block

const app = express();
app.use(cors());
app.use(bodyParser.json());

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
    res.status(200).json({ message: "OTP sent successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to send OTP" });
  }
});
app.get("/test", (req, res) => res.send("✅ Backend is working"));

// Configure multer to handle files in memory
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// ✅ Config
const MIN_WITHDRAWAL = 40;
const DOWNLOAD_COST = 10;

// Utility Functions
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateUserID() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ====================== USER ROUTES ======================


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
    res.status(500).json({ message: "Error verifying email" });
  }
});

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

// ✅ Get Available Downloads (CORRECTED - NO APPROVAL)
app.get("/get-downloads", async (req, res) => {
  try {
    // This now gets ALL files from your database without checking a status
    const uploadedFilesSnapshot = await db.collection("uploadedFiles").get();
    const uploadedFiles = uploadedFilesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json({ files: uploadedFiles });
  } catch (error) {
    console.error("❌ Error fetching downloads:", error);
    res.status(500).json({ message: "Error fetching downloads" });
  }
});
// Add this code block after your app.get("/get-downloads", ... ) route

// ✅ NEW: Public endpoint to serve files for preview
// in server.js

// Make sure 'degrees' is included in your pdf-lib import

// ... (your other code)

// ✅ UPDATED: Endpoint now serves a limited, multi-page preview
app.get("/files/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;

    // 1. Get file metadata from Firestore
    const fileDocRef = db.collection("uploadedFiles").doc(fileId);
    const fileDoc = await fileDocRef.get();
    if (!fileDoc.exists) {
      return res.status(404).send("File not found.");
    }
    const fileData = fileDoc.data();

    // 2. Fetch the original file from R2
    const getCmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileData.r2Key,
    });
    const r2Response = await r2.send(getCmd);
    const originalPdfBytes = await streamToBuffer(r2Response.Body);

    // --- 3. ✨ CREATE A NEW, SHORTER PREVIEW PDF ✨ ---
    const originalDoc = await PDFDocument.load(originalPdfBytes);
    const previewDoc = await PDFDocument.create(); // Create a new blank document

    const totalPages = originalDoc.getPageCount();
    // Show up to 5 pages, or all pages if the document is short
    const previewPageCount = Math.min(5, totalPages);

    // Copy the first 'previewPageCount' pages from the original to the new document
    const copiedPageIndices = Array.from({ length: previewPageCount }, (_, i) => i);
    const copiedPages = await previewDoc.copyPages(originalDoc, copiedPageIndices);
    copiedPages.forEach(page => previewDoc.addPage(page));

    // 4. ✨ ADD A "CALL TO ACTION" PAGE AT THE END ✨
    if (totalPages > previewPageCount) {
      const font = await previewDoc.embedFont(StandardFonts.HelveticaBold);
      const endPage = previewDoc.addPage();
      const { width, height } = endPage.getSize();
      endPage.drawText(`Preview Ended`, {
        x: width / 2 - 100,
        y: height / 2 + 50,
        size: 40, font, color: rgb(0.1, 0.1, 0.4)
      });
      endPage.drawText(`The full document contains ${totalPages} pages.`, {
        x: width / 2 - 150,
        y: height / 2,
        size: 20, font, color: rgb(0.2, 0.2, 0.5)
      });
       endPage.drawText(`Purchase to download the complete file.`, {
        x: width / 2 - 140,
        y: height / 2 - 50,
        size: 18, font, color: rgb(0.2, 0.2, 0.5)
      });
    }

    const previewPdfBytes = await previewDoc.save();

    // 5. Send the new, shorter preview PDF to the browser
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preview-${fileData.name}"`);
    return res.send(Buffer.from(previewPdfBytes));

  } catch (err) {
    console.error("❌ Error creating preview:", err);
    res.status(500).send("Server error while preparing the preview.");
  }
});

// ... your other routes like /coin-history continue below
app.get("/coin-history", async (req, res) => {
  const { email } = req.query;
  try {
    const snapshot = await db.collection("coinHistory").where("email", "==", email).get();
    if (snapshot.empty) return res.json({ history: [] });
    const history = snapshot.docs.map(doc => doc.data());
    res.json({ history });
  } catch (error) {
    res.status(500).json({ message: "Error fetching coin history" });
  }
});

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
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ====================== ADMIN ROUTES ======================

app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: "Invalid admin credentials" });
});

app.get("/get-withdraw-requests", async (req, res) => {
  try {
    const snapshot = await db.collection("withdrawRequests").where("status", "==", "pending").get();
    if (snapshot.empty) return res.json([]);
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: "Error fetching withdrawal requests" });
  }
});

app.post("/approve-withdrawal", async (req, res) => {
  const { requestId } = req.body;
  try {
    await db.collection("withdrawRequests").doc(requestId).update({
      status: "approved", approvedAt: new Date().toISOString()
    });
    res.json({ message: "Withdrawal approved successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error approving withdrawal" });
  }
});

app.post("/reject-withdrawal", async (req, res) => {
  const { requestId, email, coins } = req.body;
  try {
    await db.collection("withdrawRequests").doc(requestId).update({
      status: "rejected", rejectedAt: new Date().toISOString()
    });
    const userRef = db.collection("users").doc(email);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
      const currentCoins = userDoc.data().coins || 0;
      await userRef.update({ coins: currentCoins + coins });
      await db.collection("coinHistory").add({
        email, type: "Refund - Withdrawal Rejected", coins, date: new Date().toISOString()
      });
    }
    res.json({ message: "Withdrawal rejected and coins refunded" });
  } catch (error) {
    res.status(500).json({ message: "Error rejecting withdrawal" });
  }
});

// ✅ Admin Upload File (CORRECTED - NO APPROVAL)
app.post("/admin-upload-file", upload.single('file'), async (req, res) => {
  const { fileName } = req.body;
  const file = req.file;
  if (!fileName || !file) {
    return res.status(400).json({ success: false, message: "File name and file are required" });
  }
  try {
    const key = `${Date.now()}_${file.originalname}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype
    }));
    // We no longer add a "status" field. The file is live immediately.
    const fileData = {
      name: fileName,
      r2Key: key,
      originalName: file.originalname,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: "admin"
    };
    const docRef = await db.collection("uploadedFiles").add(fileData);
    res.json({
      success: true,
      message: "File uploaded successfully!",
      fileId: docRef.id
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error uploading file" });
  }
});

// ✅ User Upload File (CORRECTED - WITH R2 UPLOAD)
app.post("/user-upload-file", upload.single("file"), async (req, res) => {
    try {
        const { fileName, userId, category, section, tags } = req.body;
        const file = req.file;

        if (!fileName || !userId || !category || !file) {
            return res.status(400).json({ success: false, message: "Missing required fields or file" });
        }

        // --- FIX IS HERE: Added the R2 upload logic ---
        // 1. Create a unique key for the file in R2
        const key = `${Date.now()}_${file.originalname}`;

        // 2. Send the file to your R2 bucket
        await r2.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
        }));
        // --- END OF FIX ---

        const fileData = {
            name: fileName,
            userId,
            category,
            section,
            tags: JSON.parse(tags || "[]"),
            r2Key: key, // 3. Store the correct, unique key
            originalName: file.originalname,
            size: file.size,
            uploadedAt: new Date().toISOString()
        };

        const docRef = await db.collection("uploadedFiles").add(fileData);

        res.json({
            success: true,
            message: "File uploaded successfully and is now available.",
            fileId: docRef.id
        });
    } catch (err) {
        console.error("❌ Error in user upload:", err);
        res.status(500).json({ success: false, message: "Server error during file upload." });
    }
});

// ✅ Download route (Watermarking logic remains)
// This is the updated /download-file route for your server.js

app.post("/download-file", async (req, res) => {
  try {
    const { fileId, email } = req.body;
    if (!fileId || !email) {
      return res.status(400).json({ success: false, message: "Missing fileId or email" });
    }

    const fileDocRef = db.collection("uploadedFiles").doc(fileId);
    const fileDoc = await fileDocRef.get();
    if (!fileDoc.exists) {
      return res.status(404).json({ success: false, message: "File not found" });
    }
    const fileData = fileDoc.data();

    // The transaction logic for deducting coins is correct and remains the same
    const downloadDocRef = db.collection("downloadHistory").doc(`${email}_${fileId}`);
    const userRef = db.collection("users").doc(email);

    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error("USER_NOT_FOUND");

      const downloadSnap = await t.get(downloadDocRef);
      if (downloadSnap.exists) {
        return; // Already downloaded, do nothing
      }

      const currentCoins = userSnap.data().coins || 0;
      if (currentCoins < DOWNLOAD_COST) throw new Error("INSUFFICIENT_COINS");

      const newCoins = currentCoins - DOWNLOAD_COST;
      t.update(userRef, { coins: newCoins });
      t.set(downloadDocRef, {
        email, fileId, fileName: fileData.name || "unknown",
        coinsDeducted: DOWNLOAD_COST, date: new Date().toISOString()
      });
      const coinHistRef = db.collection("coinHistory").doc();
      t.set(coinHistRef, {
        email, type: "File Download", coins: -DOWNLOAD_COST,
        fileId, date: new Date().toISOString()
      });
    });

    // Fetch the file from R2
    const getCmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileData.r2Key,
    });
    const r2Response = await r2.send(getCmd);

    const fileBuffer = await streamToBuffer(r2Response.Body);

    // *** FIX IS HERE: Check if the file is a PDF before processing ***
    const isPdf = r2Response.ContentType === 'application/pdf' || (fileData.name && fileData.name.toLowerCase().endsWith('.pdf'));

    if (isPdf) {
      // If it's a PDF, proceed with watermarking
      const pdfDoc = await PDFDocument.load(fileBuffer);
      const pages = pdfDoc.getPages();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      let logoImage = null;
      try {
        const logoPath = path.join(__dirname, "studymint-logo.png");
        if (fs.existsSync(logoPath)) {
          const logoBytes = fs.readFileSync(logoPath);
          logoImage = await pdfDoc.embedPng(logoBytes);
        }
      } catch (err) {
        console.warn("Could not embed logo:", err.message);
      }

      pages.forEach((page) => {
        const { width, height } = page.getSize();
        if (logoImage) {
          const pngDims = logoImage.scale(0.22);
          page.drawImage(logoImage, {
            x: width / 2 - pngDims.width / 2, y: height / 2 - pngDims.height / 2,
            width: pngDims.width, height: pngDims.height, opacity: 0.28,
          });
        }
        page.drawText(`Downloaded by: ${email}`, {
          x: 40, y: 30, size: 10, font, color: rgb(0.45, 0.45, 0.45),
        });
      });

      const watermarkedPdfBytes = await pdfDoc.save();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fileData.name || "download.pdf"}"`);
      return res.send(Buffer.from(watermarkedPdfBytes));

    } else {
      // If it's NOT a PDF, send the original file without watermarking
      res.setHeader("Content-Type", r2Response.ContentType || 'application/octet-stream');
      res.setHeader("Content-Disposition", `attachment; filename="${fileData.name || "download"}"`);
      return res.send(fileBuffer);
    }

  } catch (err) {
    console.error("❌ Error downloading file:", err);
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (err.message === "INSUFFICIENT_COINS") {
      return res.status(400).json({ success: false, message: `Insufficient coins. You need at least ${DOWNLOAD_COST} SM coins.` });
    }
    return res.status(500).json({ success: false, message: "Server error during download" });
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
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server running on ${port}`));
}
module.exports = app;







