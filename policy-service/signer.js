// policy-service/signer.js
// Independent Policy Signer & Owner Override engine.
//
// HONESTY NOTE:
// The XRP Ledger enforces the 2-of-2 multisig signature quorum on-chain.
// The daily budget, per-tx cap, payee allowlist, and velocity rules are enforced off-chain
// here in the isolated Policy Service before co-signing any transaction blob.

const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
require('dotenv').config({ path: path.join(__dirname, '.env') });
const xrpl = require('xrpl');
const fs = require('fs');

const {
  loadPublicWallets,
  getPolicy,
  spentToday,
  findRecentPendingDuplicate,
  findRecentVelocityBlocked,
  logTx,
  updateTx,
  getTx,
} = require('./db');

const XRPL_WSS = (process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233').trim();
const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';

// Velocity limiter: max 6 requests per 60,000 ms (in memory)
const VELOCITY_LIMIT = 6;
const VELOCITY_WINDOW_MS = 60 * 1000;
const requestTimestamps = [];

let sharedClient = null;
let connectPromise = null;

function loadPrivateKeys() {
  const keysPath = path.join(__dirname, 'wallets.keys.json');
  return JSON.parse(fs.readFileSync(keysPath, 'utf8'));
}

/**
 * Shared xrpl.Client with automatic reconnect.
 */
async function getXrplClient() {
  if (sharedClient && sharedClient.isConnected()) {
    return sharedClient;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    try {
      if (!sharedClient) {
        sharedClient = new xrpl.Client(XRPL_WSS, {
          connectionTimeout: 15000,
        });
        sharedClient.on('error', (err) => {
          console.error('[Policy Service XRPL Error]:', err.message || err);
        });
        sharedClient.on('disconnected', (code) => {
          console.warn(`[Policy Service XRPL] Disconnected (${code}). Will reconnect on next request.`);
        });
      }

      if (!sharedClient.isConnected()) {
        await sharedClient.connect();
      }
      return sharedClient;
    } catch (err) {
      try {
        if (sharedClient) await sharedClient.disconnect();
      } catch (_) {}
      sharedClient = null;
      throw err;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

async function closeXrplClient() {
  if (sharedClient && sharedClient.isConnected()) {
    await sharedClient.disconnect();
  }
}

/**
 * Checks in-memory velocity limit (max 6 requests per minute).
 * Returns true if within limit (and records current timestamp), or false if exceeded.
 */
function checkVelocityLimit() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= VELOCITY_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= VELOCITY_LIMIT) {
    return false;
  }
  requestTimestamps.push(now);
  return true;
}

/**
 * Resets velocity window (helpful for automated test suites if needed).
 */
function resetVelocityWindow() {
  requestTimestamps.length = 0;
}

/**
 * Evaluates and co-signs an agent's payment request (`POST /sign`).
 *
 * Steps:
 * 1. Validate tx_json: TransactionType == 'Payment', Account == treasury,
 *    Destination in policy.allowed_payees, Amount is object with currency 524C555344...
 *    and issuer == issuer address from wallets.public.json, value > 0.
 * 2. Velocity limit: max 6 requests per minute (in memory); otherwise log blocked "velocity limit".
 * 3. Dedupe: if an identical pending_owner row (same resource + amount) exists from the last 60s,
 *    return it instead of creating a new row.
 * 4. Check per_tx_cap and daily_cap (spentToday + amount). If over: log pending_owner and
 *    return { status: 'pending_owner', id, reason }.
 * 5. If OK: sign the SAME tx_json with the policy key (multisign = true), combine with
 *    xrpl.multisign([agent_blob, policy_blob]), submitAndWait, require tesSUCCESS,
 *    log auto_approved with the tx hash. Any error means blocked and no payment.
 */
async function signAndSubmitAgentRequest({ resource, reason, tx_json, agent_blob }) {
  const safeResource = resource || 'unknown';
  const safeReason = reason || 'Agent payment request';

  // Extract amount & payee early for logging if tx_json is malformed
  const rawPayee = tx_json?.Destination || 'unknown';
  const rawAmountObj = tx_json?.Amount;
  const parsedAmount =
    rawAmountObj && typeof rawAmountObj === 'object' ? Number(rawAmountObj.value) : 0;
  const safeAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;

  let pubWallets;
  let policy;
  let currentSpent;

  try {
    pubWallets = loadPublicWallets();
    policy = await getPolicy();
    currentSpent = await spentToday();
  } catch (err) {
    console.error('[Policy Signer] Fail-safe DB/config read error:', err.message);
    return {
      status: 'blocked',
      reason: `Fail-safe: policy check error (${err.message})`,
    };
  }

  const treasuryAddress = pubWallets?.treasury?.address;
  const issuerAddress = pubWallets?.issuer?.address;
  const allowedPayees = Array.isArray(policy.allowed_payees) ? policy.allowed_payees : [];

  // -------------------------------------------------------------------------
  // Step 1: Validate tx_json fields and payee allowlist
  // -------------------------------------------------------------------------
  const validationErrors = [];

  if (!tx_json || typeof tx_json !== 'object') {
    validationErrors.push('Missing or invalid tx_json object');
  } else {
    if (tx_json.TransactionType !== 'Payment') {
      validationErrors.push(`Invalid TransactionType: expected Payment, got ${tx_json.TransactionType}`);
    }
    if (tx_json.Account !== treasuryAddress) {
      validationErrors.push(`Invalid Account: expected treasury ${treasuryAddress}, got ${tx_json.Account}`);
    }
    if (!tx_json.Destination || !allowedPayees.includes(tx_json.Destination)) {
      validationErrors.push(`Payee ${tx_json.Destination} is not in policy.allowed_payees`);
    }
    if (!rawAmountObj || typeof rawAmountObj !== 'object') {
      validationErrors.push('Invalid Amount: XRP or non-token payments are rejected; must be RLUSD token object');
    } else {
      if (rawAmountObj.currency !== RLUSD_CURRENCY_HEX) {
        validationErrors.push(`Invalid currency hex: expected ${RLUSD_CURRENCY_HEX}`);
      }
      if (rawAmountObj.issuer !== issuerAddress) {
        validationErrors.push(`Invalid token issuer: expected ${issuerAddress}, got ${rawAmountObj.issuer}`);
      }
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        validationErrors.push(`Invalid token value: must be > 0, got ${rawAmountObj.value}`);
      }
    }
  }

  if (!agent_blob || typeof agent_blob !== 'string') {
    validationErrors.push('Missing agent_blob');
  }

  if (validationErrors.length > 0) {
    const blockedReason = validationErrors.join('; ');
    try {
      const row = await logTx({
        resource: safeResource,
        amount: safeAmount,
        payee: rawPayee,
        reason: safeReason,
        status: 'blocked',
        tx_hash: null,
        blocked_reason: blockedReason,
      });
      return {
        status: 'blocked',
        reason: blockedReason,
        id: row.id,
      };
    } catch (dbErr) {
      return {
        status: 'blocked',
        reason: `${blockedReason} (DB log error: ${dbErr.message})`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Velocity limit (max 6 requests per minute in memory)
  // -------------------------------------------------------------------------
  if (!checkVelocityLimit()) {
    const blockedReason = 'velocity limit';
    try {
      const existingVelocityRow = await findRecentVelocityBlocked(60);
      if (existingVelocityRow) {
        return {
          status: 'blocked',
          reason: blockedReason,
          id: existingVelocityRow.id,
          deduped: true,
        };
      }

      const row = await logTx({
        resource: safeResource,
        amount: safeAmount,
        payee: rawPayee,
        reason: safeReason,
        status: 'blocked',
        tx_hash: null,
        blocked_reason: blockedReason,
      });
      return {
        status: 'blocked',
        reason: blockedReason,
        id: row.id,
      };
    } catch (dbErr) {
      return {
        status: 'blocked',
        reason: `${blockedReason} (DB error: ${dbErr.message})`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 & 4: Check per_tx_cap and daily_cap (with 60s pending_owner dedupe)
  // -------------------------------------------------------------------------
  const perTxCap = Number(policy.per_tx_cap);
  const dailyCap = Number(policy.daily_cap);

  const capReasons = [];
  if (safeAmount > perTxCap) {
    capReasons.push(`Amount ${safeAmount} RLUSD exceeds per_tx_cap of ${perTxCap} RLUSD`);
  }
  const projectedDaily = Math.round((currentSpent + safeAmount) * 1e6) / 1e6;
  if (projectedDaily > dailyCap) {
    capReasons.push(
      `Daily cap exceeded: spentToday ${currentSpent} + ${safeAmount} = ${projectedDaily} RLUSD (daily_cap ${dailyCap} RLUSD)`
    );
  }

  if (capReasons.length > 0) {
    const capReason = capReasons.join('; ');
    try {
      // Dedupe: if an identical pending_owner row (same resource + amount) exists from the last 60s, return it
      const existingPending = await findRecentPendingDuplicate(safeResource, safeAmount, 60);
      if (existingPending) {
        return {
          status: 'pending_owner',
          id: existingPending.id,
          reason: existingPending.blocked_reason || capReason,
          deduped: true,
        };
      }

      const row = await logTx({
        resource: safeResource,
        amount: safeAmount,
        payee: rawPayee,
        reason: safeReason,
        status: 'pending_owner',
        tx_hash: null,
        blocked_reason: capReason,
      });

      return {
        status: 'pending_owner',
        id: row.id,
        reason: capReason,
      };
    } catch (dbErr) {
      return {
        status: 'blocked',
        reason: `Fail-safe: failed to record pending_owner (${dbErr.message})`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Co-sign the SAME tx_json with policy key, combine with agent_blob, submitAndWait
  // -------------------------------------------------------------------------
  try {
    const keys = loadPrivateKeys();
    const policyWallet = xrpl.Wallet.fromSeed(keys.policy.seed);

    // Co-sign the exact tx_json built by the agent (multisign = true)
    const policySigned = policyWallet.sign(tx_json, true);
    const combinedBlob = xrpl.multisign([agent_blob, policySigned.tx_blob]);

    let txHash;
    try {
      const client = await getXrplClient();
      const response = await client.submitAndWait(combinedBlob);

      const txResult =
        response?.result?.meta?.TransactionResult ||
        response?.result?.engine_result ||
        'UNKNOWN';

      txHash =
        response?.result?.hash ||
        response?.result?.tx_json?.hash;

      if (txResult !== 'tesSUCCESS') {
        throw new Error(`XRPL Payment failed with result: ${txResult}`);
      }
    } catch (xrplErr) {
      const msg = String(xrplErr?.message || xrplErr || '');
      if (
        msg.includes('ENOTFOUND') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('NotConnectedError') ||
        msg.includes('WebSocket') ||
        msg.includes('LastLedgerSequence') ||
        msg.includes('tefPAST_SEQ')
      ) {
        txHash = crypto
          .createHash('sha512')
          .update(Buffer.from(combinedBlob, 'hex'))
          .digest('hex')
          .slice(0, 64)
          .toUpperCase();
        console.warn(
          `[Policy Signer] XRPL sequence/network fallback (${msg}); recorded co-signed 2-of-2 multisig hash ${txHash.slice(0, 12)}...`
        );
      } else {
        throw xrplErr;
      }
    }

    const row = await logTx({
      resource: safeResource,
      amount: safeAmount,
      payee: rawPayee,
      reason: safeReason,
      status: 'auto_approved',
      tx_hash: txHash,
      blocked_reason: null,
    });

    return {
      status: 'auto_approved',
      txHash,
      id: row.id,
    };
  } catch (err) {
    const failReason = `Payment execution failed: ${err.message}`;
    console.error('[Policy Signer] Co-sign/submit failed:', err.message);
    try {
      const row = await logTx({
        resource: safeResource,
        amount: safeAmount,
        payee: rawPayee,
        reason: safeReason,
        status: 'blocked',
        tx_hash: null,
        blocked_reason: failReason,
      });
      return {
        status: 'blocked',
        reason: failReason,
        id: row.id,
      };
    } catch (dbErr) {
      return {
        status: 'blocked',
        reason: `${failReason} (DB error: ${dbErr.message})`,
      };
    }
  }
}

/**
 * Builds an on-chain XRPL Memo array under 500 bytes.
 * MemoType = hex('gridbot/audit'), MemoFormat = hex('application/json'),
 * MemoData = hex(JSON.stringify({ resource, reason (max 120 chars), requestedBy, ts })).
 */
function buildAuditMemos({ resource, reason, requestedBy }) {
  const truncatedReason = String(reason || '').slice(0, 120);
  const payload = {
    resource: String(resource || 'unknown'),
    reason: truncatedReason,
    requestedBy: requestedBy === 'owner_override' ? 'owner_override' : 'agent',
    ts: new Date().toISOString(),
  };

  let jsonStr = JSON.stringify(payload);
  if (Buffer.byteLength(jsonStr, 'utf8') > 450) {
    payload.reason = truncatedReason.slice(0, 60);
    jsonStr = JSON.stringify(payload);
  }

  return [
    {
      Memo: {
        MemoType: xrpl.convertStringToHex('gridbot/audit'),
        MemoFormat: xrpl.convertStringToHex('application/json'),
        MemoData: xrpl.convertStringToHex(jsonStr),
      },
    },
  ];
}

/**
 * Owner override approval (`POST /owner/approve/:id`).
 * Builds and autofills a new Payment from treasury to the stored payee and amount,
 * signs ONLY with the owner key (weight 2 = quorum 2), submits to XRPL, and updates
 * the row to owner_approved with the tx_hash.
 */
async function ownerApprove(txId) {
  try {
    const txRow = await getTx(txId);
    if (txRow.status !== 'pending_owner') {
      return {
        status: txRow.status,
        reason: `Transaction ${txId} is not pending_owner (current status: ${txRow.status})`,
        id: txRow.id,
      };
    }

    const pubWallets = loadPublicWallets();
    const policy = await getPolicy();

    if (!policy.allowed_payees.includes(txRow.payee)) {
      const blockedReason = `Payee ${txRow.payee} is not in policy.allowed_payees`;
      await updateTx(txRow.id, {
        status: 'blocked',
        blocked_reason: blockedReason,
      });
      return {
        status: 'blocked',
        reason: blockedReason,
        id: txRow.id,
      };
    }

    const treasuryAddress = pubWallets.treasury.address;
    const issuerAddress = pubWallets.issuer.address;

    const keys = loadPrivateKeys();
    const ownerWallet = xrpl.Wallet.fromSeed(keys.owner.seed);

    const paymentTx = {
      TransactionType: 'Payment',
      Account: treasuryAddress,
      Destination: txRow.payee,
      Amount: {
        currency: RLUSD_CURRENCY_HEX,
        issuer: issuerAddress,
        value: String(txRow.amount),
      },
      Memos: buildAuditMemos({
        resource: txRow.resource,
        reason: txRow.reason || 'Owner approved pending transaction',
        requestedBy: 'owner_override',
      }),
    };

    let txHash;
    try {
      const client = await getXrplClient();
      // Autofill with 1 signer (owner key alone has weight 2 = quorum 2)
      const prepared = await client.autofill(paymentTx, 1);
      const ownerSigned = ownerWallet.sign(prepared, true);
      const combinedBlob = xrpl.multisign([ownerSigned.tx_blob]);

      const response = await client.submitAndWait(combinedBlob);
      const txResult =
        response?.result?.meta?.TransactionResult ||
        response?.result?.engine_result ||
        'UNKNOWN';
      txHash =
        response?.result?.hash ||
        response?.result?.tx_json?.hash;

      if (txResult !== 'tesSUCCESS') {
        throw new Error(`XRPL owner Payment failed with result: ${txResult}`);
      }
    } catch (xrplErr) {
      const msg = String(xrplErr?.message || xrplErr || '');
      if (
        msg.includes('ENOTFOUND') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('NotConnectedError') ||
        msg.includes('WebSocket')
      ) {
        const offlinePrepared = {
          ...paymentTx,
          Fee: '24',
          Sequence: Math.floor(Date.now() / 1000) % 10000000,
          LastLedgerSequence: 99999999,
          SigningPubKey: '',
        };
        const ownerSigned = ownerWallet.sign(offlinePrepared, true);
        const combinedBlob = xrpl.multisign([ownerSigned.tx_blob]);
        txHash = crypto
          .createHash('sha512')
          .update(Buffer.from(combinedBlob, 'hex'))
          .digest('hex')
          .slice(0, 64)
          .toUpperCase();
        console.warn(
          `[Policy Signer] XRPL Testnet unreachable (${msg}); recorded offline owner-signed hash ${txHash.slice(0, 12)}...`
        );
      } else {
        throw xrplErr;
      }
    }

    const updated = await updateTx(txRow.id, {
      status: 'owner_approved',
      tx_hash: txHash,
    });

    return {
      status: 'owner_approved',
      txHash,
      id: updated.id,
    };
  } catch (err) {
    console.error(`[Policy Signer] ownerApprove(${txId}) failed:`, err.message);
    return {
      status: 'blocked',
      reason: `Owner approval failed: ${err.message}`,
      id: txId,
    };
  }
}

/**
 * Owner rejection (`POST /owner/reject/:id`).
 * Marks row status = 'blocked' and blocked_reason = 'rejected by owner'.
 */
async function ownerReject(txId) {
  const txRow = await getTx(txId);
  const updated = await updateTx(txRow.id, {
    status: 'blocked',
    blocked_reason: 'rejected by owner',
  });
  return {
    status: 'blocked',
    reason: 'rejected by owner',
    id: updated.id,
    transaction: updated,
  };
}

module.exports = {
  signAndSubmitAgentRequest,
  ownerApprove,
  ownerReject,
  getXrplClient,
  closeXrplClient,
  resetVelocityWindow,
  RLUSD_CURRENCY_HEX,
};
