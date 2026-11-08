// server.js
// Express + WebSocket (ws) backend for GridBot.
//
// HONESTY NOTE:
// The XRP Ledger does NOT track the daily budget or per-transaction caps.
// Those spending rules live off-chain in policy-signer.js and Supabase, which refuse
// to co-sign over the cap. The ledger enforces that no payment executes without the
// required multisig quorum (agent weight 1 + policy weight 1 = 2, or owner weight 2 = 2).

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const { getPolicy, updatePolicy, spentToday, listTx, getTx } = require('./db');
const { ownerApprove, closeXrplClient } = require('./policy-signer');
const { setLevel, getResource } = require('./resources');
const {
  emitter: monitorEmitter,
  start: startMonitor,
  stop: stopMonitor,
  getSnapshot,
  checkNow,
} = require('./monitor');
const {
  handleLow,
  setRogueMode,
  isRogueMode,
  agentEvents,
} = require('./agent');
const {
  initTelegram,
  notifyPendingOwner,
  notifyAutoApproved,
} = require('./telegram');

const PORT = Number(process.env.PORT) || 3000;
const XRPL_EXPLORER_BASE =
  process.env.XRPL_EXPLORER_BASE || 'https://testnet.xrpl.org/transactions';

/**
 * Explorer link helper: https://testnet.xrpl.org/transactions/{hash}
 */
function explorerUrl(txHash) {
  if (!txHash) return null;
  return `${XRPL_EXPLORER_BASE.replace(/\/$/, '')}/${txHash}`;
}

/**
 * Decorates a transaction row with explorerUrl if it has a tx_hash.
 */
function decorateTx(tx) {
  if (!tx) return null;
  return {
    ...tx,
    explorerUrl: tx.tx_hash ? explorerUrl(tx.tx_hash) : null,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Broadcasts a JSON message to all connected WebSocket clients.
 */
function broadcast(type, payload = {}) {
  const message = JSON.stringify({
    type,
    ts: new Date().toISOString(),
    ...payload,
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Computes current budget summary (off-chain policy + spentToday + remaining).
 */
async function getBudgetSummary() {
  const policy = await getPolicy();
  const spent = await spentToday();
  const dailyCap = Number(policy.daily_cap);
  const perTxCap = Number(policy.per_tx_cap);
  const budgetRemaining = Math.max(0, Math.round((dailyCap - spent) * 1e6) / 1e6);

  return {
    policy,
    spentToday: spent,
    dailyCap,
    perTxCap,
    budgetRemaining,
  };
}

const { ensureLocalWalletsFile } = require('./setup-wallets');

/**
 * Loads public wallet addresses (never seeds) for UI display.
 */
function getPublicWallets() {
  try {
    const raw = ensureLocalWalletsFile();
    return {
      treasuryAddress: raw?.treasury?.address || null,
      utilityAddress: raw?.utility?.address || null,
      agentAddress: raw?.agent?.address || null,
      policyAddress: raw?.policy?.address || null,
      ownerAddress: raw?.owner?.address || null,
    };
  } catch (err) {
    return {
      treasuryAddress: null,
      utilityAddress: null,
      agentAddress: null,
      policyAddress: null,
      ownerAddress: null,
    };
  }
}

/**
 * Builds the complete application state for GET /api/state and initial WS connection.
 */
async function buildFullState() {
  const levels = getSnapshot();
  const { policy, spentToday: spent, budgetRemaining } = await getBudgetSummary();
  const rawTransactions = await listTx(50);
  const transactions = rawTransactions.map(decorateTx);
  const wallets = getPublicWallets();

  return {
    levels,
    policy,
    spentToday: spent,
    budgetRemaining,
    rogueMode: isRogueMode(),
    treasuryAddress: wallets.treasuryAddress,
    utilityAddress: wallets.utilityAddress,
    wallets,
    transactions,
  };
}

/**
 * Broadcasts budget_update + recent transactions + current levels.
 */
async function broadcastBudgetAndTxUpdate(triggerReason = 'update') {
  try {
    const { policy, spentToday: spent, budgetRemaining } = await getBudgetSummary();
    const rawTransactions = await listTx(50);
    const transactions = rawTransactions.map(decorateTx);

    broadcast('budget', {
      policy,
      spentToday: spent,
      budgetRemaining,
    });

    broadcast('transactions', {
      reason: triggerReason,
      transactions,
      spentToday: spent,
      budgetRemaining,
    });
  } catch (err) {
    console.error('[Server] Failed to broadcast budget/tx update:', err.message);
  }
}

// ============================================================================
// Wire Monitor & Agent Events -> WebSocket Broadcasts
// ============================================================================

// 1. Every 2s tick from monitor.js -> broadcast 'levels'
monitorEmitter.on('level', (levels) => {
  broadcast('levels', { levels });
});

// Prevent overlapping handleLow calls for the same resource at the exact same moment
const activeLowHandlers = new Set();

// 2. Monitor 'low' -> agent.handleLow -> broadcast happens via agentEvents 'decision'
monitorEmitter.on('low', async (lowEvent) => {
  const resourceId = lowEvent.id;
  if (activeLowHandlers.has(resourceId)) return;
  activeLowHandlers.add(resourceId);

  broadcast('low_alert', {
    resource: resourceId,
    label: lowEvent.label,
    level: lowEvent.level,
    threshold: lowEvent.threshold,
  });

  try {
    await handleLow(lowEvent);
  } catch (err) {
    console.error(`[Server] Error in agent.handleLow(${resourceId}):`, err.message);
    broadcast('agent_error', {
      resource: resourceId,
      error: err.message,
    });
  } finally {
    activeLowHandlers.delete(resourceId);
  }
});

// 3. Whenever agent finishes a decision (from 'low' OR from rogue mode tick) -> broadcast
agentEvents.on('decision', async (result) => {
  const txHash = result?.payment?.txHash || null;
  const enrichedResult = {
    ...result,
    payment: result.payment
      ? {
          ...result.payment,
          explorerUrl: explorerUrl(txHash),
        }
      : null,
  };

  // Broadcast agent decision (includes proposal with reason, payment result, and vend token/bundle)
  broadcast('decision', {
    decision: enrichedResult,
    levels: getSnapshot(),
  });

  // Also broadcast updated levels (in case vend() refilled the resource to 100%)
  broadcast('levels', { levels: getSnapshot() });

  // Broadcast updated transactions list & budget remaining
  await broadcastBudgetAndTxUpdate('agent_decision');

  // 4. Send Telegram notification to OWNER_CHAT_ID
  try {
    const payStatus = result?.payment?.status;
    const proposal = result?.proposal || {};

    if (payStatus === 'pending_owner' && result?.payment?.id !== undefined) {
      const { budgetRemaining } = await getBudgetSummary();
      await notifyPendingOwner({
        id: result.payment.id,
        resource: proposal.resource,
        amount: proposal.amount,
        reason: proposal.reason,
        blockedReason: result.payment.reason,
        remainingBudget: budgetRemaining,
      });
    } else if (payStatus === 'auto_approved') {
      await notifyAutoApproved({
        resource: proposal.resource,
        amount: proposal.amount,
        reason: proposal.reason,
        txHash,
        vend: result.vend,
      });
    }
  } catch (tgErr) {
    console.error('[Server -> Telegram] Notification error:', tgErr.message);
  }
});

agentEvents.on('rogue', ({ rogueMode }) => {
  broadcast('rogue', { rogueMode });
});

// ============================================================================
// REST API Endpoints
// ============================================================================

// GET /api/state -> (levels, policy, spentToday, budgetRemaining, rogueMode, recent transactions)
app.get('/api/state', async (req, res) => {
  try {
    const state = await buildFullState();
    res.json({ ok: true, ...state });
  } catch (err) {
    console.error('[GET /api/state] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/demo/drain/:resource -> forces resource level to 6
app.post('/api/demo/drain/:resource', (req, res) => {
  try {
    const resourceId = req.params.resource;
    getResource(resourceId); // validates resource exists ('electricity' or 'data')

    const newLevel = setLevel(resourceId, 6);
    const levels = checkNow(); // immediately emits 'level' and evaluates 'low'

    res.json({
      ok: true,
      resource: resourceId,
      level: newLevel,
      levels,
    });
  } catch (err) {
    console.error('[POST /api/demo/drain/:resource] Error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/demo/rogue -> toggles rogue mode (or sets explicit boolean if { enabled } passed)
app.post('/api/demo/rogue', (req, res) => {
  try {
    const nextState =
      typeof req.body?.enabled === 'boolean' ? req.body.enabled : !isRogueMode();
    const rogueMode = setRogueMode(nextState);

    res.json({
      ok: true,
      rogueMode,
    });
  } catch (err) {
    console.error('[POST /api/demo/rogue] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/demo/reset -> stops rogue mode and refills both resources to 100%
app.post('/api/demo/reset', async (req, res) => {
  try {
    setRogueMode(false);
    setLevel('electricity', 100);
    setLevel('data', 100);
    const levels = checkNow();

    res.json({
      ok: true,
      rogueMode: false,
      levels,
    });
  } catch (err) {
    console.error('[POST /api/demo/reset] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/policy -> updates daily_cap, per_tx_cap, and/or allowed_payees
app.post('/api/policy', async (req, res) => {
  try {
    const { daily_cap, per_tx_cap, allowed_payees } = req.body || {};
    const updates = {};

    if (daily_cap !== undefined) {
      const numDaily = Number(daily_cap);
      if (!Number.isFinite(numDaily) || numDaily < 0) {
        return res.status(400).json({ ok: false, error: 'daily_cap must be a non-negative number' });
      }
      updates.daily_cap = numDaily;
    }

    if (per_tx_cap !== undefined) {
      const numPerTx = Number(per_tx_cap);
      if (!Number.isFinite(numPerTx) || numPerTx < 0) {
        return res.status(400).json({ ok: false, error: 'per_tx_cap must be a non-negative number' });
      }
      updates.per_tx_cap = numPerTx;
    }

    if (allowed_payees !== undefined) {
      if (!Array.isArray(allowed_payees)) {
        return res.status(400).json({ ok: false, error: 'allowed_payees must be an array of addresses' });
      }
      updates.allowed_payees = allowed_payees;
    }

    const updatedPolicy = await updatePolicy(updates);
    const { spentToday: spent, budgetRemaining } = await getBudgetSummary();

    broadcast('budget', {
      policy: updatedPolicy,
      spentToday: spent,
      budgetRemaining,
    });

    res.json({
      ok: true,
      policy: updatedPolicy,
      spentToday: spent,
      budgetRemaining,
    });
  } catch (err) {
    console.error('[POST /api/policy] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/approve/:id -> calls ownerApprove(id), vends resource if approved, and broadcasts updates
app.post('/api/approve/:id', async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;

    const txBefore = await getTx(txId);
    const approveResult = await ownerApprove(txId);

    let vendResult = null;
    if (approveResult.status === 'owner_approved') {
      try {
        const plugin = getResource(txBefore.resource);
        vendResult = plugin.vend(txBefore.amount);
        broadcast('levels', { levels: getSnapshot() });
      } catch (vendErr) {
        console.warn('[POST /api/approve/:id] Resource vend warning:', vendErr.message);
      }
    }

    const updatedTx = decorateTx(await getTx(txId));
    await broadcastBudgetAndTxUpdate('owner_approve');

    broadcast('owner_approved', {
      transaction: updatedTx,
      approveResult: {
        ...approveResult,
        explorerUrl: explorerUrl(approveResult.txHash),
      },
      vend: vendResult,
    });

    const statusCode = approveResult.status === 'owner_approved' ? 200 : 400;
    res.status(statusCode).json({
      ok: approveResult.status === 'owner_approved',
      ...approveResult,
      explorerUrl: explorerUrl(approveResult.txHash),
      transaction: updatedTx,
      vend: vendResult,
    });
  } catch (err) {
    console.error('[POST /api/approve/:id] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// WebSocket Connection Handler
// ============================================================================

wss.on('connection', async (ws) => {
  try {
    const state = await buildFullState();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'init',
          ts: new Date().toISOString(),
          ...state,
        })
      );
    }
  } catch (err) {
    console.error('[WS connection init] Error sending initial state:', err.message);
  }
});

// ============================================================================
// Server Startup & Graceful Shutdown
// ============================================================================

function startServer() {
  initTelegram({
    onStateChanged: async (evt) => {
      broadcast('levels', { levels: getSnapshot() });
      await broadcastBudgetAndTxUpdate(`telegram_${evt.type}`);
      if (evt.type === 'owner_approved') {
        const updatedTx = decorateTx(await getTx(evt.txId));
        broadcast('owner_approved', {
          transaction: updatedTx,
          approveResult: {
            ...evt.approveResult,
            explorerUrl: explorerUrl(evt.approveResult?.txHash),
          },
          vend: evt.vend,
        });
      }
    },
  });

  startMonitor(2000);
  server.listen(PORT, () => {
    console.log(`GridBot server running at http://localhost:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

process.on('SIGINT', async () => {
  stopMonitor();
  setRogueMode(false);
  await closeXrplClient();
  process.exit(0);
});

module.exports = {
  app,
  server,
  wss,
  startServer,
  broadcast,
  explorerUrl,
};
