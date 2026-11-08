// policy-signer.js
// Off-chain Policy Signer service for GridBot.
//
// HONESTY NOTE:
// The XRP Ledger does NOT know or track the daily budget or per-transaction caps.
// Those spending rules live off-chain in this Policy Signer service, which refuses to
// co-sign transactions that exceed the owner's configured limits or target non-allowlisted payees.
// What the XRP Ledger enforces is cryptographic multisig: the Treasury account's master key is
// disabled and its SignerList requires quorum = 2 (agent weight 1 + policy weight 1 = 2, or
// owner weight 2 = 2). The agent key alone (weight 1) can never move funds on-chain.

require('dotenv').config();
const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');
const { getPolicy, spentToday, logTx, updateTx, getTx } = require('./db');
const { pay } = require('./pay');

const XRPL_WSS = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';

let sharedClient = null;
let connectPromise = null;

const { ensureLocalWalletsFile } = require('./setup-wallets');

function loadWallets() {
  return ensureLocalWalletsFile();
}

/**
 * Returns a connected shared xrpl.Client instance with automatic reconnect.
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
          console.error('[XRPL Client Error]:', err.message || err);
        });
        sharedClient.on('disconnected', (code) => {
          console.warn(`[XRPL Client] Disconnected (code ${code}). Will reconnect on next request.`);
        });
      }

      if (!sharedClient.isConnected()) {
        await sharedClient.connect();
      }
      return sharedClient;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

/**
 * Cleanly disconnects the shared XRPL client (useful for tests/shutdown).
 */
async function closeXrplClient() {
  if (sharedClient && sharedClient.isConnected()) {
    await sharedClient.disconnect();
  }
}

/**
 * Helper to execute pay() regardless of whether pay.js produces { txHash } or a raw submitAndWait response.
 */
async function executeMultisigPay(client, signers, amount, payee) {
  const res = await pay(client, signers, amount, payee);
  if (!res) {
    throw new Error('pay() returned empty response');
  }
  if (typeof res === 'string') {
    return res;
  }
  if (res.txHash) {
    return res.txHash;
  }
  const txResult = res?.result?.meta?.TransactionResult || res?.result?.engine_result;
  if (txResult && txResult !== 'tesSUCCESS') {
    throw new Error(`XRPL transaction failed with ${txResult}`);
  }
  const hash = res?.result?.hash || res?.result?.tx_json?.hash || res?.hash;
  if (!hash) {
    throw new Error('Could not extract txHash from pay() response');
  }
  return hash;
}

/**
 * Evaluates a payment request against off-chain spending rules and, if compliant,
 * co-signs with (agent + policy) keys and submits to XRPL Testnet.
 *
 * Fail-safe: any DB or XRPL error aborts before signing/paying.
 *
 * @param {object} params
 * @param {string} params.resource - e.g. 'electricity' | 'data'
 * @param {number} params.amount - RLUSD amount requested
 * @param {string} params.payee - Destination classic address
 * @param {string} params.reason - Reason for purchase
 * @returns {Promise<{status: string, txHash?: string, reason?: string, id?: number|string}>}
 */
async function requestPayment({ resource, amount, payee, reason }) {
  const numericAmount = Number(amount);

  if (!resource || !payee || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    const invalidReason = 'Invalid payment parameters (resource, valid positive amount, and payee required)';
    try {
      const row = await logTx({
        resource: resource || 'unknown',
        amount: Number.isFinite(numericAmount) ? numericAmount : 0,
        payee: payee || 'unknown',
        reason: reason || 'Invalid request',
        status: 'blocked',
        tx_hash: null,
        blocked_reason: invalidReason,
      });
      return { status: 'blocked', reason: invalidReason, id: row.id };
    } catch (dbErr) {
      // Fail-safe: DB error means do not pay
      return { status: 'blocked', reason: `Fail-safe block (DB error): ${dbErr.message}` };
    }
  }

  let policy;
  let currentSpent;
  try {
    // Any DB error throws -> caught below -> do not pay
    policy = await getPolicy();
    currentSpent = await spentToday();
  } catch (dbErr) {
    console.error('[Policy Signer] Fail-safe triggered: DB read failed, refusing to sign:', dbErr.message);
    return {
      status: 'blocked',
      reason: `Fail-safe: database error while verifying policy (${dbErr.message})`,
    };
  }

  const allowedPayees = Array.isArray(policy.allowed_payees) ? policy.allowed_payees : [];
  const perTxCap = Number(policy.per_tx_cap);
  const dailyCap = Number(policy.daily_cap);

  // 1. Check payee allowlist first
  if (!allowedPayees.includes(payee)) {
    const blockedReason = `Payee ${payee} is not in the allowlist`;
    try {
      const row = await logTx({
        resource,
        amount: numericAmount,
        payee,
        reason,
        status: 'blocked',
        tx_hash: null,
        blocked_reason: blockedReason,
      });
      return { status: 'blocked', reason: blockedReason, id: row.id };
    } catch (dbErr) {
      return { status: 'blocked', reason: `${blockedReason} (and DB log failed: ${dbErr.message})` };
    }
  }

  // 2. Check spending caps (per_tx_cap and daily_cap)
  const capReasons = [];
  if (numericAmount > perTxCap) {
    capReasons.push(
      `Amount ${numericAmount} RLUSD exceeds per-transaction cap of ${perTxCap} RLUSD`
    );
  }
  const projectedDailyTotal = Math.round((currentSpent + numericAmount) * 1e6) / 1e6;
  if (projectedDailyTotal > dailyCap) {
    capReasons.push(
      `Daily cap exceeded: spent today ${currentSpent} RLUSD + ${numericAmount} RLUSD = ${projectedDailyTotal} RLUSD (daily cap is ${dailyCap} RLUSD)`
    );
  }

  // 3. If failure is ONLY the caps (payee is allowlisted), log pending_owner and return pending id
  if (capReasons.length > 0) {
    const blockedReason = capReasons.join('; ');
    try {
      const row = await logTx({
        resource,
        amount: numericAmount,
        payee,
        reason,
        status: 'pending_owner',
        tx_hash: null,
        blocked_reason: blockedReason,
      });
      return {
        status: 'pending_owner',
        reason: blockedReason,
        id: row.id,
      };
    } catch (dbErr) {
      console.error('[Policy Signer] Failed to log pending_owner tx, refusing payment:', dbErr.message);
      return {
        status: 'blocked',
        reason: `Fail-safe: could not record pending_owner transaction (${dbErr.message})`,
      };
    }
  }

  // 4. Passed all policy checks! Sign with agent (weight 1) + policy (weight 1) = quorum 2
  try {
    const wallets = loadWallets();
    const agentWallet = xrpl.Wallet.fromSeed(wallets.agent.seed);
    const policyWallet = xrpl.Wallet.fromSeed(wallets.policy.seed);

    const client = await getXrplClient();
    const txHash = await executeMultisigPay(
      client,
      [agentWallet, policyWallet],
      numericAmount,
      payee
    );

    const row = await logTx({
      resource,
      amount: numericAmount,
      payee,
      reason,
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
    console.error('[Policy Signer] Error during multisig payment:', err.message);
    try {
      const row = await logTx({
        resource,
        amount: numericAmount,
        payee,
        reason,
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
 * Owner override approval for a pending_owner transaction.
 * Signs with the owner key alone (weight 2 = quorum 2), submits to XRPL Testnet,
 * and updates the row to owner_approved with the tx_hash.
 *
 * @param {number|string} txId - ID of the pending_owner transaction row
 * @returns {Promise<{status: string, txHash?: string, reason?: string, id: number|string}>}
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

    // Re-verify payee is allowlisted even on owner cap override
    const policy = await getPolicy();
    if (!policy.allowed_payees.includes(txRow.payee)) {
      const blockedReason = `Payee ${txRow.payee} is not allowlisted`;
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

    const wallets = loadWallets();
    const ownerWallet = xrpl.Wallet.fromSeed(wallets.owner.seed);

    const client = await getXrplClient();
    // Owner key has weight 2, satisfying quorum 2 alone
    const txHash = await executeMultisigPay(
      client,
      [ownerWallet],
      Number(txRow.amount),
      txRow.payee
    );

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

module.exports = {
  requestPayment,
  ownerApprove,
  getXrplClient,
  closeXrplClient,
};
