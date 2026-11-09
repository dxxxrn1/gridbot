// test-policy-service.js
// End-to-end verification of the isolated Policy Service (port 4000):
// 1. Builds a Payment the way the agent would (agent key only from wallets.agent.json,
//    public addresses from wallets.public.json, autofilled with signersCount = 2).
// 2. POST /sign for 5 RLUSD -> expects 'auto_approved'.
// 3. Keeps sending 3 RLUSD requests (with distinct resources/amounts or after budget fills)
//    until 'pending_owner' is returned.
// 4. Calls POST /owner/approve/:id with x-owner-passcode -> expects 'owner_approved'.
// 5. Calls POST /sign to a random payee -> expects 'blocked'.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, 'policy-service', '.env') });

const fs = require('fs');
const xrpl = require('xrpl');

const POLICY_SERVICE_URL = (process.env.POLICY_SERVICE_URL || 'http://localhost:4000').replace(/\/$/, '');
const AGENT_API_TOKEN = (process.env.AGENT_API_TOKEN || '').trim();
const OWNER_PASSCODE = (process.env.OWNER_PASSCODE || '').trim();
const XRPL_WSS = (process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233').trim();
const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';

function loadPublicWallets() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'wallets.public.json'), 'utf8'));
}

function loadAgentWallet() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallets.agent.json'), 'utf8'));
  return xrpl.Wallet.fromSeed(data.agent.seed);
}

/**
 * Helper to ensure policy-service is reachable; if not already running in another terminal,
 * starts it in-process on port 4000 for convenience so `node test-policy-service.js` always works.
 */
async function ensurePolicyServiceRunning() {
  try {
    const res = await fetch(`${POLICY_SERVICE_URL}/state`, {
      headers: { 'x-agent-token': AGENT_API_TOKEN },
    });
    if (res.ok || res.status === 401) {
      return null; // Already running externally
    }
  } catch {
    console.log('[Test] Policy service not yet listening on port 4000 — starting it for this test...');
    const { startPolicyServer } = require('./policy-service/server');
    const srv = startPolicyServer(4000);
    await new Promise((r) => setTimeout(r, 500));
    return srv;
  }
  return null;
}

/**
 * Builds an autofilled Payment (signersCount = 2) and signs ONLY with the agent key (weight 1).
 */
async function buildAgentSignedRequest(client, { amount, destination, resource, reason }) {
  const pub = loadPublicWallets();
  const agentWallet = loadAgentWallet();

  const paymentTx = {
    TransactionType: 'Payment',
    Account: pub.treasury.address,
    Destination: destination || pub.utility.address,
    Amount: {
      currency: RLUSD_CURRENCY_HEX,
      issuer: pub.issuer.address,
      value: String(amount),
    },
  };

  // Autofill with 2 signers (agent + policy)
  const tx_json = await client.autofill(paymentTx, 2);
  const agent_blob = agentWallet.sign(tx_json, true).tx_blob;

  return {
    resource,
    reason,
    tx_json,
    agent_blob,
  };
}

async function postSign(payload) {
  const res = await fetch(`${POLICY_SERVICE_URL}/sign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-token': AGENT_API_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function postOwnerApprove(id) {
  const res = await fetch(`${POLICY_SERVICE_URL}/owner/approve/${id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-passcode': OWNER_PASSCODE,
    },
  });
  return res.json();
}

async function getState() {
  const res = await fetch(`${POLICY_SERVICE_URL}/state`, {
    headers: { 'x-agent-token': AGENT_API_TOKEN },
  });
  return res.json();
}

async function run() {
  console.log('=== GridBot Part 1 Test: Isolated Policy Service (Port 4000) ===\n');

  const localServer = await ensurePolicyServiceRunning();
  const client = new xrpl.Client(XRPL_WSS);
  await client.connect();

  try {
    const pub = loadPublicWallets();
    const initialState = await getState();
    console.log('Initial Policy State:', {
      policy: initialState.policy,
      spentToday: initialState.spentToday,
      budgetRemaining: initialState.budgetRemaining,
    });

    // 1. POST /sign for 5 RLUSD (expect auto_approved, or pending_owner if today's cap was already spent)
    console.log('\n--- Step 1: Agent builds & signs 5 RLUSD Payment -> POST /sign ---');
    const req5 = await buildAgentSignedRequest(client, {
      amount: 5,
      destination: pub.utility.address,
      resource: 'electricity',
      reason: 'Electricity meter at 4% (test 5 RLUSD)',
    });
    const res5 = await postSign(req5);
    console.log('5 RLUSD /sign response:', res5);

    // 2. Keep sending 3 RLUSD until pending_owner
    console.log('\n--- Step 2: Sending 3 RLUSD requests until pending_owner ---');
    let pendingId = res5.status === 'pending_owner' ? res5.id : null;
    let attempt = 0;

    while (!pendingId && attempt < 6) {
      attempt += 1;
      console.log(`\n[3 RLUSD Request #${attempt}]`);
      const req3 = await buildAgentSignedRequest(client, {
        amount: 3,
        destination: pub.utility.address,
        resource: attempt % 2 === 1 ? 'data' : 'electricity',
        reason: `Automated 3 RLUSD top-up #${attempt}`,
      });
      const res3 = await postSign(req3);
      console.log(`Result #${attempt}:`, res3);

      if (res3.status === 'pending_owner') {
        pendingId = res3.id;
        break;
      }
    }

    // 3. Call /owner/approve/:id with the owner passcode
    console.log('\n--- Step 3: Calling POST /owner/approve/:id with OWNER_PASSCODE ---');
    if (!pendingId) {
      console.warn('No pending_owner transaction was produced to approve.');
    } else {
      console.log(`Approving pending transaction ID #${pendingId}...`);
      const approveRes = await postOwnerApprove(pendingId);
      console.log('Owner Approve Response:', approveRes);
    }

    // 4. POST /sign to a random (non-allowlisted) payee -> expect blocked
    console.log('\n--- Step 4: Agent attempts POST /sign to a random non-allowlisted payee ---');
    const randomPayee = xrpl.Wallet.generate().classicAddress;
    const reqRandom = await buildAgentSignedRequest(client, {
      amount: 2,
      destination: randomPayee,
      resource: 'data',
      reason: `Attempted transfer to unapproved address ${randomPayee}`,
    });
    const resRandom = await postSign(reqRandom);
    console.log('Random Payee /sign response (expect blocked):', resRandom);

    // Final state summary
    const finalState = await getState();
    console.log(
      `\nFinal Spent Today: ${finalState.spentToday} RLUSD | Remaining: ${finalState.budgetRemaining} RLUSD`
    );
  } finally {
    await client.disconnect();
    if (localServer) {
      const { closeXrplClient } = require('./policy-service/signer');
      await closeXrplClient();
      localServer.close();
    }
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
