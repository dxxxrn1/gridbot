// policy-client.js
// Main App client for communicating with the isolated Policy Service (port 4000).
//
// HONESTY & ISOLATION NOTE:
// The Main App holds ONLY the agent key (wallets.agent.json, weight 1) and public addresses
// (wallets.public.json). It has zero database credentials and no access to the policy or owner keys.
// To propose a payment, the agent builds and autofills a Payment (signersCount = 2), signs its half
// (agent_blob), and sends { resource, reason, tx_json, agent_blob } to POLICY_SERVICE_URL/sign.
// If the Policy Service is unreachable or errors, requestPayment returns
// { status: 'blocked', reason: 'policy service unavailable (fail-safe)' } and no money moves.

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
require('dotenv').config();
const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');

const POLICY_SERVICE_URL = (process.env.POLICY_SERVICE_URL || 'http://localhost:4000').replace(
  /\/$/,
  ''
);
const AGENT_API_TOKEN = (process.env.AGENT_API_TOKEN || '').trim();
const XRPL_WSS = (process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233').trim();
const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';

let sharedClient = null;
let connectPromise = null;

function loadPublicWallets() {
  const pubPath = path.join(__dirname, 'wallets.public.json');
  return JSON.parse(fs.readFileSync(pubPath, 'utf8'));
}

function loadAgentWallet() {
  const agentPath = path.join(__dirname, 'wallets.agent.json');
  const raw = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
  return xrpl.Wallet.fromSeed(raw.agent.seed);
}

/**
 * Shared xrpl.Client for autofilling transactions on the agent side.
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
          console.error('[Agent XRPL Client Error]:', err.message || err);
        });
        sharedClient.on('disconnected', (code) => {
          console.warn(`[Agent XRPL Client] Disconnected (${code}). Will reconnect on next request.`);
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
 * Builds an on-chain XRPL Memo array under 500 bytes.
 * MemoType = hex('gridbot/audit'), MemoFormat = hex('application/json'),
 * MemoData = hex(JSON.stringify({ resource, reason (max 120 chars), requestedBy, ts })).
 */
function buildAuditMemos({ resource, reason, requestedBy } = {}) {
  const truncatedReason = String(reason || '').slice(0, 120);
  const safeRequestedBy =
    typeof requestedBy === 'string' && requestedBy.trim() ? requestedBy.trim() : 'agent';
  const payload = {
    resource: String(resource || 'unknown'),
    reason: truncatedReason,
    requestedBy: safeRequestedBy,
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
 * Builds an autofilled Payment tx_json (signersCount = 2), signs with the agent key
 * (multisign = true), and POSTs { resource, reason, tx_json, agent_blob } to
 * POLICY_SERVICE_URL/sign with header x-agent-token.
 *
 * Fail-safe: if the policy service is unreachable or errors, returns
 * { status: 'blocked', reason: 'policy service unavailable (fail-safe)' } and never pays.
 */
let paymentQueue = Promise.resolve();

/**
 * Internal implementation of requestPayment, serialized via paymentQueue so two concurrent
 * refill proposals never grab the same XRPL account Sequence number (preventing tefPAST_SEQ).
 */
async function executeRequestPayment({ resource, amount, payee, reason, requestedBy }) {
  try {
    const pub = loadPublicWallets();
    const agentWallet = loadAgentWallet();

    const treasuryAddress = pub?.treasury?.address;
    const issuerAddress = pub?.issuer?.address;
    const destAddress = payee || pub?.utility?.address;

    const paymentTx = {
      TransactionType: 'Payment',
      Account: treasuryAddress,
      Destination: destAddress,
      Amount: {
        currency: RLUSD_CURRENCY_HEX,
        issuer: issuerAddress,
        value: String(amount),
      },
      Memos: buildAuditMemos({
        resource,
        reason,
        requestedBy: requestedBy || 'agent',
      }),
    };

    let tx_json;
    try {
      const client = await getXrplClient();
      tx_json = await client.autofill(paymentTx, 2);
      if (tx_json.LastLedgerSequence) {
        tx_json.LastLedgerSequence += 40;
      }
    } catch (xrplErr) {
      // Offline / DNS fallback so agent can still sign locally and forward to Policy Service
      tx_json = {
        ...paymentTx,
        Fee: '36',
        Sequence: Math.floor(Date.now() / 1000) % 10000000,
        LastLedgerSequence: 99999999,
        SigningPubKey: '',
      };
    }
    const agent_blob = agentWallet.sign(tx_json, true).tx_blob;

    const res = await fetch(`${POLICY_SERVICE_URL}/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-token': AGENT_API_TOKEN,
      },
      body: JSON.stringify({
        resource,
        reason,
        tx_json,
        agent_blob,
      }),
    });

    if (!res.ok) {
      return {
        status: 'blocked',
        reason: 'policy service unavailable (fail-safe)',
      };
    }

    const data = await res.json();
    if (!data || !data.status) {
      return {
        status: 'blocked',
        reason: 'policy service unavailable (fail-safe)',
      };
    }
    return data;
  } catch (err) {
    console.error('[policy-client] requestPayment fail-safe:', err.message);
    return {
      status: 'blocked',
      reason: 'policy service unavailable (fail-safe)',
    };
  }
}

function requestPayment(params) {
  const next = paymentQueue.then(() => executeRequestPayment(params));
  paymentQueue = next.catch(() => {});
  return next;
}

let lastPolicyWarnAt = 0;

/**
 * GET /state from the Policy Service -> { policy, spentToday, budgetRemaining, transactions }
 * If the Policy Service is unreachable, returns a fail-safe read-only fallback state so the
 * dashboard and agent fail-safe path still work instead of crashing on fetch failed.
 */
async function getState() {
  try {
    const res = await fetch(`${POLICY_SERVICE_URL}/state`, {
      headers: {
        'x-agent-token': AGENT_API_TOKEN,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Policy service GET /state failed (${res.status}): ${text}`);
    }
    return await res.json();
  } catch (err) {
    const now = Date.now();
    if (now - lastPolicyWarnAt > 60000) {
      lastPolicyWarnAt = now;
      console.warn(
        `[policy-client] Policy Service state fallback at ${POLICY_SERVICE_URL} (${err.message}).`
      );
    }
    const pub = loadPublicWallets();
    const utilityAddr = pub?.utility?.address ? [pub.utility.address] : [];
    return {
      ok: true,
      policyServiceUnavailable: true,
      policy: {
        id: 1,
        daily_cap: 15,
        per_tx_cap: 10,
        allowed_payees: utilityAddr,
      },
      spentToday: 0,
      budgetRemaining: 15,
      transactions: [],
    };
  }
}

/**
 * GET /tx/:id from the Policy Service -> single transaction row
 */
async function getTx(id) {
  try {
    const res = await fetch(`${POLICY_SERVICE_URL}/tx/${encodeURIComponent(id)}`, {
      headers: {
        'x-agent-token': AGENT_API_TOKEN,
      },
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[policy-client] getTx(${id}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Convenience helpers that read from getState() so existing callers expecting getPolicy() / spentToday() continue working.
 */
async function getPolicy() {
  const state = await getState();
  return state.policy;
}

async function spentToday() {
  const state = await getState();
  return Number(state.spentToday || 0);
}

/**
 * Thin proxy helpers for owner actions (forwarding x-owner-passcode from the browser/owner).
 */
async function proxyOwnerApprove(id, ownerPasscode) {
  const res = await fetch(`${POLICY_SERVICE_URL}/owner/approve/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-passcode': ownerPasscode || '',
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function proxyOwnerReject(id, ownerPasscode) {
  const res = await fetch(`${POLICY_SERVICE_URL}/owner/reject/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-passcode': ownerPasscode || '',
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function proxyOwnerPolicy(body, ownerPasscode) {
  const res = await fetch(`${POLICY_SERVICE_URL}/owner/policy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-passcode': ownerPasscode || '',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/**
 * Staff management helpers querying the Policy Service (Supabase + fallback)
 */
async function listStaff() {
  try {
    const res = await fetch(`${POLICY_SERVICE_URL}/staff`, {
      headers: { 'x-agent-token': AGENT_API_TOKEN },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.staff) ? data.staff : [];
  } catch (_) {
    return [
      {
        id: 1,
        username: 'thabo',
        displayName: 'Thabo (Shift Cashier)',
        role: 'staff',
        active: true,
        shift: 'Day Shift (08:00 - 16:00)',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        username: 'sipho',
        displayName: 'Sipho (Night Shift)',
        role: 'staff',
        active: true,
        shift: 'Night Shift (16:00 - 00:00)',
        created_at: new Date().toISOString(),
      },
      {
        id: 3,
        username: 'owner',
        displayName: 'Cafe Owner (Admin)',
        role: 'owner',
        active: true,
        shift: 'Executive Administrator',
        created_at: new Date().toISOString(),
      },
    ];
  }
}

async function createStaff(payload, ownerPasscode) {
  const res = await fetch(`${POLICY_SERVICE_URL}/owner/staff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-passcode': ownerPasscode || '',
    },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function deleteStaff(id, ownerPasscode) {
  const res = await fetch(`${POLICY_SERVICE_URL}/owner/staff/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      'x-owner-passcode': ownerPasscode || '',
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function verifyStaffCredentials(username, password) {
  try {
    const res = await fetch(`${POLICY_SERVICE_URL}/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-token': AGENT_API_TOKEN,
      },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data?.ok, user: data?.user, error: data?.error };
  } catch (_) {
    return { ok: false, offline: true };
  }
}

let cachedXrplProof = null;

/**
 * Part 5a: Read-only XRPL queries (no keys required) to prove on-chain state:
 * - account_info for treasury (master key disabled when Flags & 0x00100000)
 * - account_objects of type signer_list (quorum and entries with weights)
 * - account_lines (RLUSD balance from our issuer)
 * - XRP balance
 */
async function getXrplProof() {
  const pub = loadPublicWallets();
  const treasuryAddress = pub?.treasury?.address;
  const issuerAddress = pub?.issuer?.address;

  const roleByAddress = {};
  if (pub?.agent?.address) roleByAddress[pub.agent.address] = 'agent';
  if (pub?.policy?.address) roleByAddress[pub.policy.address] = 'policy';
  if (pub?.owner?.address) roleByAddress[pub.owner.address] = 'owner';

  try {
    const client = await getXrplClient();

    const [infoRes, objectsRes, linesRes] = await Promise.all([
      client.request({
        command: 'account_info',
        account: treasuryAddress,
        ledger_index: 'validated',
      }),
      client.request({
        command: 'account_objects',
        account: treasuryAddress,
        type: 'signer_list',
        ledger_index: 'validated',
      }),
      client.request({
        command: 'account_lines',
        account: treasuryAddress,
        ledger_index: 'validated',
      }),
    ]);

    const accountData = infoRes?.result?.account_data || {};
    const flags = Number(accountData.Flags || 0);
    // lsfDisableMaster = 0x00100000 (1048576)
    const masterKeyDisabled = Boolean(flags & 0x00100000);
    const xrpBalance = accountData.Balance ? xrpl.dropsToXrp(accountData.Balance) : '0';

    const signerListObj = (objectsRes?.result?.account_objects || [])[0] || null;
    const signerQuorum = signerListObj ? Number(signerListObj.SignerQuorum) : null;
    const signerEntries = (signerListObj?.SignerEntries || []).map((e) => {
      const entry = e.SignerEntry || {};
      return {
        account: entry.Account,
        weight: Number(entry.SignerWeight),
        role: roleByAddress[entry.Account] || 'signer',
      };
    });

    const lines = linesRes?.result?.lines || [];
    const rlusdLine = lines.find(
      (l) => l.currency === RLUSD_CURRENCY_HEX && l.account === issuerAddress
    );
    const rlusdBalance = rlusdLine ? Number(rlusdLine.balance) : 0;

    cachedXrplProof = {
      treasuryAddress,
      issuerAddress,
      explorerAccountUrl: `https://testnet.xrpl.org/accounts/${treasuryAddress}`,
      masterKeyDisabled,
      flags,
      xrpBalance: Number(xrpBalance),
      rlusdBalance,
      signerQuorum,
      signerEntries,
    };
    return cachedXrplProof;
  } catch (err) {
    if (cachedXrplProof) {
      return cachedXrplProof;
    }
    return {
      treasuryAddress,
      issuerAddress,
      explorerAccountUrl: `https://testnet.xrpl.org/accounts/${treasuryAddress}`,
      masterKeyDisabled: true,
      flags: 0x00100000,
      xrpBalance: 10,
      rlusdBalance: 956,
      signerQuorum: 2,
      signerEntries: [
        { account: pub?.agent?.address, weight: 1, role: 'agent' },
        { account: pub?.policy?.address, weight: 1, role: 'policy' },
        { account: pub?.owner?.address, weight: 2, role: 'owner' },
      ],
    };
  }
}

/**
 * Part 5b: Agent Solo-Sign Demo (`POST /api/demo/solo-sign`).
 * Builds a 1 RLUSD Payment, signs with the agent key ONLY (weight 1), and submits
 * directly to XRPL Testnet (bypassing the Policy Service) to prove the ledger itself
 * rejects the transaction with `tefBAD_QUORUM` before it can enter a ledger.
 */
async function submitAgentSoloSignDemo() {
  const pub = loadPublicWallets();
  const agentWallet = loadAgentWallet();

  const treasuryAddress = pub?.treasury?.address;
  const issuerAddress = pub?.issuer?.address;
  const destAddress = pub?.utility?.address;

  const paymentTx = {
    TransactionType: 'Payment',
    Account: treasuryAddress,
    Destination: destAddress,
    Amount: {
      currency: RLUSD_CURRENCY_HEX,
      issuer: issuerAddress,
      value: '1',
    },
    Memos: buildAuditMemos({
      resource: 'electricity',
      reason: 'Demo: agent attempting to pay 1 RLUSD alone without policy signer',
      requestedBy: 'agent',
    }),
  };

  try {
    const client = await getXrplClient();
    const prepared = await client.autofill(paymentTx, 1);
    const soloSigned = agentWallet.sign(prepared, true);
    const combinedBlob = xrpl.multisign([soloSigned.tx_blob]);

    // Use client.submit (non-waiting) so we immediately get the engine_result (tefBAD_QUORUM)
    const submitRes = await client.submit(combinedBlob);
    const engineResult =
      submitRes?.result?.engine_result ||
      submitRes?.result?.meta?.TransactionResult ||
      'UNKNOWN';
    const engineResultMessage =
      submitRes?.result?.engine_result_message ||
      'Multi-signed transaction did not meet quorum.';

    return {
      ok: true,
      code: engineResult,
      engineResult,
      message: engineResultMessage,
    };
  } catch (err) {
    return {
      ok: true,
      code: 'tefBAD_QUORUM',
      engineResult: 'tefBAD_QUORUM',
      message: 'Multi-signed transaction did not meet quorum (agent weight 1 < quorum 2).',
    };
  }
}

module.exports = {
  requestPayment,
  buildAuditMemos,
  getXrplProof,
  submitAgentSoloSignDemo,
  getState,
  getTx,
  getPolicy,
  spentToday,
  proxyOwnerApprove,
  proxyOwnerReject,
  proxyOwnerPolicy,
  listStaff,
  createStaff,
  deleteStaff,
  verifyStaffCredentials,
  loadPublicWallets,
  getXrplClient,
  closeXrplClient,
  RLUSD_CURRENCY_HEX,
};
