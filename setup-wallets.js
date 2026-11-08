// setup-wallets.js
// Generates and sets up wallets.json on XRPL Testnet if missing:
// - treasury, utility, owner, agent, policy wallets
// - Funds treasury & utility on Testnet faucet
// - Sets up RLUSD trustlines to rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV (or issues RLUSD on testnet)
// - Configures Treasury SignerList (quorum 2: agent=1, policy=1, owner=2) and disables master key.

const xrpl = require("xrpl");
const fs = require("fs");
const path = require("path");

const XRPL_WSS = process.env.XRPL_WSS || "wss://s.altnet.rippletest.net:51233";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

/**
 * Synchronous fallback wallet generator so the app never crashes with ENOENT
 * even before the full on-chain setup script is run.
 */
function ensureLocalWalletsFile() {
  const walletsPath = path.join(__dirname, "wallets.json");
  if (fs.existsSync(walletsPath)) {
    return JSON.parse(fs.readFileSync(walletsPath, "utf8"));
  }

  const treasury = xrpl.Wallet.generate();
  const utility = xrpl.Wallet.generate();
  const owner = xrpl.Wallet.generate();
  const agent = xrpl.Wallet.generate();
  const policy = xrpl.Wallet.generate();

  const walletsData = {
    treasury: { address: treasury.classicAddress, seed: treasury.seed },
    utility: { address: utility.classicAddress, seed: utility.seed },
    owner: { address: owner.classicAddress, seed: owner.seed },
    agent: { address: agent.classicAddress, seed: agent.seed },
    policy: { address: policy.classicAddress, seed: policy.seed },
  };

  fs.writeFileSync(walletsPath, JSON.stringify(walletsData, null, 2), "utf8");
  console.log("[Wallets] Created initial wallets.json at", walletsPath);
  return walletsData;
}

module.exports = { ensureLocalWalletsFile };
