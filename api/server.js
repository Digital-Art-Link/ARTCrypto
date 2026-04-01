const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase setup ────────────────────────────────────────────────────────────
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "digital-art-link"  
});

const db = admin.firestore();
const USERS_COLLECTION = "users";

// ── Helper: find user by wallet address ──────────────────────────────────────
async function getUserByAddress(walletAddress) {
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where("walletAddress", "==", walletAddress)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const data = snapshot.docs[0].data();
  return {
    id:               snapshot.docs[0].id,
    username:         data.username,
    email:            data.email,
    userType:         data.userType,
    isTopArtist:      data.isTopArtist,
    isVerifiedSeller: data.isVerifiedSeller,
    artBalance:       data.artBalance || "0",
    walletAddress:    data.walletAddress
  };
}

// ── Helper: save a new document to any collection ────────────────────────────
async function saveToFirebase(collection, data) {
  try {
    const ref = await db.collection(collection).add({
      ...data,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`[Firebase] Saved to '${collection}': ${ref.id}`);
  } catch (err) {
    console.error(`[Firebase] Error saving to '${collection}':`, err.message);
  }
}

// ── Helper: sync ART balance onto existing user document ─────────────────────
async function syncUserBalance(walletAddress, newBalance) {
  try {
    const snapshot = await db
      .collection(USERS_COLLECTION)
      .where("walletAddress", "==", walletAddress)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      await snapshot.docs[0].ref.update({
        artBalance: newBalance,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[Firebase] Synced balance for ${walletAddress}: ${newBalance} ART`);
    } else {
      console.log(`[Firebase] No user found with walletAddress: ${walletAddress}`);
    }
  } catch (err) {
    console.error(`[Firebase] Balance sync error:`, err.message);
  }
}

// ── Blockchain setup ──────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

const deployment = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../deployment.json"))
);
const artifact = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../artifacts/contracts/ArtCoin.sol/ArtCoin.json")
  )
);

const contract = new ethers.Contract(
  deployment.contractAddress,
  artifact.abi,
  provider
);

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /token — basic token info
app.get("/token", async (req, res) => {
  try {
    const name        = await contract.name();
    const symbol      = await contract.symbol();
    const totalSupply = await contract.totalSupply();
    const maxSupply   = await contract.MAX_SUPPLY();
    const paused      = await contract.paused();

    res.json({
      name,
      symbol,
      contractAddress: deployment.contractAddress,
      totalSupply:     ethers.formatUnits(totalSupply, 18),
      maxSupply:       ethers.formatUnits(maxSupply, 18),
      paused
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /balance/:address — live balance + sync to Firebase user
app.get("/balance/:address", async (req, res) => {
  try {
    const balance   = await contract.balanceOf(req.params.address);
    const formatted = ethers.formatUnits(balance, 18);

    await syncUserBalance(req.params.address, formatted);

    res.json({
      address: req.params.address,
      balance: formatted,
      symbol:  "ART"
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /user/:address — full Firebase user profile + live ART balance
app.get("/user/:address", async (req, res) => {
  try {
    const user = await getUserByAddress(req.params.address);
    if (!user) {
      return res.status(404).json({
        error: "No user found with that wallet address"
      });
    }

    const balance = await contract.balanceOf(req.params.address);
    res.json({
      ...user,
      artBalance: ethers.formatUnits(balance, 18),
      symbol:     "ART"
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /transfer — send ART between wallets + sync both users in Firebase
// Body: { fromPrivateKey, toAddress, amount }
app.post("/transfer", async (req, res) => {
  try {
    const { fromPrivateKey, toAddress, amount } = req.body;
    const signer = new ethers.Wallet(fromPrivateKey, provider);

    const tx = await contract.connect(signer).transfer(
      toAddress,
      ethers.parseUnits(amount.toString(), 18)
    );
    const receipt = await tx.wait();

    // Look up both users in Firebase
    const sender   = await getUserByAddress(signer.address);
    const receiver = await getUserByAddress(toAddress);

    const result = {
      txHash:       receipt.hash,
      from:         signer.address,
      to:           toAddress,
      amount:       amount.toString(),
      blockNumber:  receipt.blockNumber,
      senderUser:   sender?.username   || "unknown",
      receiverUser: receiver?.username || "unknown"
    };

    // Save transaction record to Firebase
    await saveToFirebase("transactions", result);

    // Sync updated balances for both wallets
    const senderBalance   = ethers.formatUnits(
      await contract.balanceOf(signer.address), 18
    );
    const receiverBalance = ethers.formatUnits(
      await contract.balanceOf(toAddress), 18
    );
    await syncUserBalance(signer.address, senderBalance);
    await syncUserBalance(toAddress, receiverBalance);

    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /transfer/user
// Body: { fromUserId, toAddress, amount }
// Looks up private key from Firebase so frontend never touches it
app.post("/transfer/user", async (req, res) => {
  try {
    const { fromUserId, toAddress, amount } = req.body;

    // Fetch sender's full document from Firebase
    const senderDoc = await db
      .collection(USERS_COLLECTION)
      .doc(fromUserId)
      .get();

    if (!senderDoc.exists) {
      return res.status(404).json({ error: "Sender user not found" });
    }

    const senderData = senderDoc.data();

    if (!senderData.privateKey) {
      return res.status(400).json({ error: "No wallet key on file for this user" });
    }

    const signer = new ethers.Wallet(senderData.privateKey, provider);

    const tx = await contract.connect(signer).transfer(
      toAddress,
      ethers.parseUnits(amount.toString(), 18)
    );
    const receipt = await tx.wait();

    const receiver = await getUserByAddress(toAddress);

    const result = {
      txHash:       receipt.hash,
      from:         senderData.walletAddress,
      to:           toAddress,
      amount:       amount.toString(),
      blockNumber:  receipt.blockNumber,
      senderUser:   senderData.username  || "unknown",
      receiverUser: receiver?.username   || "unknown"
    };

    await saveToFirebase("transactions", result);

    // Sync both balances
    const senderBalance   = ethers.formatUnits(
      await contract.balanceOf(senderData.walletAddress), 18
    );
    const receiverBalance = ethers.formatUnits(
      await contract.balanceOf(toAddress), 18
    );
    await syncUserBalance(senderData.walletAddress, senderBalance);
    await syncUserBalance(toAddress, receiverBalance);

    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /transactions — last 50 transactions from Firebase
app.get("/transactions", async (req, res) => {
  try {
    const snapshot = await db
      .collection("transactions")
      .orderBy("timestamp", "desc")
      .limit(50)
      .get();

    const txs = snapshot.docs.map(doc => ({
      id:        doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate()
    }));

    res.json(txs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /transactions/chain — transactions directly from blockchain
app.get("/transactions/chain", async (req, res) => {
  try {
    const events = await contract.queryFilter(
      contract.filters.Transfer(), 0
    );
    res.json(events.map(e => ({
      txHash:      e.transactionHash,
      from:        e.args[0],
      to:          e.args[1],
      amount:      ethers.formatUnits(e.args[2], 18),
      blockNumber: e.blockNumber
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(3001, () => {
  console.log("🚀 ArtCoin API running at http://localhost:3001");
  console.log("   GET  /token");
  console.log("   GET  /balance/:address       ← syncs artBalance to Firebase user");
  console.log("   GET  /user/:address           ← full user profile + ART balance");
  console.log("   POST /transfer                ← executes tx + syncs both users");
  console.log("   GET  /transactions            ← from Firebase");
  console.log("   GET  /transactions/chain      ← directly from blockchain");
});