require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const admin = require("firebase-admin");
const fs = require("fs");
const bcrypt = require("bcryptjs");
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
let serviceAccount = null;
let db = null;

// ✅ Load Firebase credentials from Base64 (Render secret)
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    serviceAccount = JSON.parse(json);
    console.log("✅ Firebase service account loaded from Base64 secret.");
  } catch (e) {
    console.error("❌ ERROR parsing Base64 Firebase credentials:", e.message);
  }
} else {
  // 🔄 Fallback: local file for dev
  const serviceAccountPath = path.join(__dirname, "serviceaccountkey.json");
  if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
    console.log("✅ Firebase service account loaded from local file.");
  } else {
    console.error("❌ ERROR: Firebase service account not found locally or in Base64 env var.");
  }
}

// ✅ Initialize Firebase only if credentials are available
if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log("🔥 Firebase initialized successfully.");
  } catch (e) {
    console.error("❌ ERROR initializing Firebase Admin SDK:", e.message);
  }
}
// End of Firebase setup block

const app = express();

// 🔹 Step 3: Add CORS setup before routes
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (
      origin.includes("wixsite.com") ||
      origin.includes("filesusr.com") ||
      origin.includes("editorx.io") ||
      origin.includes("parastorage.com") ||
      origin.includes("render.com") ||
      origin.includes("localhost") ||
      origin.includes("127.0.0.1")
    ) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
};

// ✅ Apply CORS middleware once
app.use(cors(corsOptions));

// ✅ Allow embedding in Wix iframes
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://*.wixsite.com https://*.filesusr.com https://*.editorx.io https://*.parastorage.com;"
  );
  next();
});


// 🔹 Step 4: Middleware
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));


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
const SALT_ROUNDS = 10; // Security constant

app.post("/user-login", async (req, res) => {
  const { email, password } = req.body;
  const loginEmail = email.trim().toLowerCase();
  
  if (!loginEmail || !password) {
    return res.status(400).json({ message: "Email and Password are required" });
  }

  try {
    const userRef = db.collection("users").doc(loginEmail);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      // --- LOGIN PATH ---
      const data = userDoc.data();
      const isMatch = await bcrypt.compare(password, data.passwordHash);

      if (isMatch) {
        return res.json({ 
          message: "Login successful", 
          userID: data.userID, 
          coins: data.coins 
        });
      } else {
        return res.status(401).json({ message: "Invalid Password" });
      }

    } else {
      // --- REGISTRATION PATH ---
      const userID = generateUserID();
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      
      await userRef.set({ 
        email: loginEmail, 
        userID, 
        coins: 50, 
        passwordHash, // Save the hashed password
        createdAt: new Date().toISOString() 
      });

      await db.collection("coinHistory").add({
        email: loginEmail, 
        type: "Signup Bonus", 
        coins: 50, 
        date: new Date().toISOString()
      });

      return res.json({ 
        message: "Registration successful. Welcome!", 
        userID, 
        coins: 50 
      });
    }
  } catch (error) {
    console.error("User Login/Registration Error:", error);
    res.status(500).json({ message: "Server error during login/registration" });
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

// Utility: convert R2 stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}


// ====================== DOWNLOAD FILE ======================
app.get("/download-file", async (req, res) => {
  try {
    const { email, fileId } = req.query; // get from URL
    if (!email || !fileId) return res.status(400).send("Missing parameters");

    // 1️⃣ Get user
    const userDoc = await db.collection("users").doc(email).get();
    if (!userDoc.exists) return res.status(404).send("User not found");
    const user = userDoc.data();
    if (user.coins < DOWNLOAD_COST) return res.status(400).send("Insufficient coins");

    // Deduct coins
    await db.collection("users").doc(email).update({ coins: user.coins - DOWNLOAD_COST });

    // 2️⃣ Get file data
    const fileDoc = await db.collection("uploadedFiles").doc(fileId).get();
    if (!fileDoc.exists) return res.status(404).send("File not found");
    const fileData = fileDoc.data();

    // 3️⃣ Fetch file from R2
    const getCmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: fileData.r2Key });
    const r2Response = await r2.send(getCmd);
    const fileBuffer = await streamToBuffer(r2Response.Body);

    // 4️⃣ Send file as attachment
    res.setHeader("Content-Type", r2Response.ContentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${fileData.name}"`);
    return res.send(fileBuffer);

  } catch (err) {
    console.error("Download error:", err);
    res.status(500).send("Server error during download");
  }
});



// ====================== START SERVER ======================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});





































