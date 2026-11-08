// pay.js
// Executes multisigned RLUSD payments from the Treasury account on XRPL Testnet.
// Treasury master key is disabled; SignerList has quorum 2:
// - agent (weight 1) + policy (weight 1) = 2 (normal auto-approved payments)
// - owner (weight 2) = 2 (owner override approval)

const xrpl = require("xrpl");
const fs = require("fs");
const path = require("path");

const { ensureLocalWalletsFile } = require("./setup-wallets");

function loadWallets() {
  return ensureLocalWalletsFile();
}

const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000";
const RLUSD_ISSUER =
  loadWallets()?.issuer?.address || "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

/**
 * Multisigns and submits an RLUSD Payment from the treasury account.
 * @param {xrpl.Client} client - Connected xrpl.Client instance
 * @param {Array<xrpl.Wallet|string|{seed: string}>} signers - Array of Wallet instances, seeds, or wallet objects
 * @param {number|string} amount - RLUSD amount to send
 * @param {string} [destination] - Optional destination address (defaults to wallets.utility.address)
 * @returns {Promise<{txHash: string, result: string, response: object}>}
 */
async function pay(client, signers, amount, destination) {
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error("pay() requires at least one signer");
  }

  const wallets = loadWallets();
  const treasuryAddress = wallets.treasury.address;
  const destAddress = destination || wallets.utility.address;
  const issuerAddress = wallets?.issuer?.address || RLUSD_ISSUER;

  const signerWallets = signers.map((s) => {
    if (s && typeof s.sign === "function" && s.classicAddress) {
      return s;
    }
    if (typeof s === "string") {
      return xrpl.Wallet.fromSeed(s);
    }
    if (s && typeof s.seed === "string") {
      return xrpl.Wallet.fromSeed(s.seed);
    }
    throw new Error("Invalid signer passed to pay()");
  });

  const paymentTx = {
    TransactionType: "Payment",
    Account: treasuryAddress,
    Destination: destAddress,
    Amount: {
      currency: RLUSD_CURRENCY_HEX,
      issuer: issuerAddress,
      value: String(amount),
    },
  };

  // Autofill with multisig signer count so Fee is scaled for N signers
  const prepared = await client.autofill(paymentTx, signerWallets.length);

  // Each signer signs the prepared tx with multisig = true
  const signedBlobs = signerWallets.map(
    (wallet) => wallet.sign(prepared, true).tx_blob,
  );

  // Combine individual multisig blobs into one multisigned transaction blob
  const combinedBlob = xrpl.multisign(signedBlobs);

  // Submit and wait for validation on XRPL Testnet
  const response = await client.submitAndWait(combinedBlob);

  const txResult =
    response?.result?.meta?.TransactionResult ||
    response?.result?.engine_result ||
    "UNKNOWN";

  const txHash = response?.result?.hash || response?.result?.tx_json?.hash;

  if (txResult !== "tesSUCCESS") {
    throw new Error(`XRPL Payment failed with result: ${txResult}`);
  }

  return {
    txHash,
    result: txResult,
    response,
  };
}

module.exports = {
  pay,
  RLUSD_CURRENCY_HEX,
  RLUSD_ISSUER,
};
