// test.js
// Part 1 verification test:
// 1. 5 RLUSD request (should pass -> auto_approved)
// 2. 6 more requests of 3 RLUSD (5 + 3 + 3 + 3 = 14 <= 15 pass; remaining hit daily cap 15 -> pending_owner)
// 3. ownerApprove on the first pending_owner transaction (-> owner_approved)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getPolicy, spentToday, listTx } = require("./db");
const {
  requestPayment,
  ownerApprove,
  closeXrplClient,
} = require("./policy-signer");

function loadWallets() {
  const walletsPath = path.join(__dirname, "wallets.json");
  return JSON.parse(fs.readFileSync(walletsPath, "utf8"));
}

async function run() {
  console.log(
    "=== GridBot Part 1 Test: Supabase DB + Off-Chain Policy Signer ===\n",
  );

  const wallets = loadWallets();
  const utilityAddress = wallets.utility.address;

  const policy = await getPolicy();
  console.log("Active Policy:", policy);

  const initialSpent = await spentToday();
  console.log(
    `Initial Spent Today (since midnight Africa/Johannesburg): ${initialSpent} RLUSD\n`,
  );

  // Step 1: 5 RLUSD request (should pass)
  console.log("--- Step 1: Requesting 5 RLUSD for electricity ---");
  const res1 = await requestPayment({
    resource: "electricity",
    amount: 5,
    payee: utilityAddress,
    reason: "Prepaid electricity meter low (test 5 RLUSD)",
  });
  console.log("Result 1:", res1);
  console.log(`Spent today is now: ${await spentToday()} RLUSD\n`);

  require("dotenv").config();
  console.log("URL:", JSON.stringify(process.env.SUPABASE_URL));
  fetch(process.env.SUPABASE_URL + "/rest/v1/", {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY },
  })
    .then((r) => console.log("Reached Supabase, status:", r.status))
    .catch((e) => console.log("FAILED:", e.cause || e));

  // Step 2: 6 more requests of 3 RLUSD
  console.log("--- Step 2: Running 6 requests of 3 RLUSD each ---");
  const pendingIds = [];

  for (let i = 1; i <= 6; i++) {
    console.log(`\n[3 RLUSD Request #${i}/6]`);
    const res = await requestPayment({
      resource: i % 2 === 0 ? "data" : "electricity",
      amount: 3,
      payee: utilityAddress,
      reason: `Automated top-up #${i} (3 RLUSD)`,
    });
    console.log(`Result #${i}:`, res);
    console.log(`Spent today: ${await spentToday()} RLUSD`);

    if (res.status === "pending_owner" && res.id !== undefined) {
      pendingIds.push(res.id);
    }
  }

  // Step 3: ownerApprove on the first pending one
  console.log(
    "\n--- Step 3: Owner approving first pending_owner transaction ---",
  );
  if (pendingIds.length === 0) {
    console.warn(
      "No pending_owner transactions were created! Check initial spentToday or daily_cap.",
    );
  } else {
    const firstPendingId = pendingIds[0];
    console.log(
      `Approving transaction ID: ${firstPendingId} with owner key (weight 2)...`,
    );
    const approveRes = await ownerApprove(firstPendingId);
    console.log("Owner Approve Result:", approveRes);
    console.log(
      `Spent today after owner approval: ${await spentToday()} RLUSD`,
    );
  }

  console.log("\n--- Recent Transactions in Supabase ---");
  const recent = await listTx(10);
  console.table(
    recent.map((tx) => ({
      id: tx.id,
      status: tx.status,
      resource: tx.resource,
      amount: tx.amount,
      tx_hash: tx.tx_hash ? `${tx.tx_hash.slice(0, 12)}...` : null,
      blocked_reason: tx.blocked_reason ? tx.blocked_reason.slice(0, 45) : null,
    })),
  );
}

run()
  .catch((err) => {
    console.error("Test failed with error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeXrplClient();
  });
