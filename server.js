// server.js
// Express + WebSocket (ws) backend for the GridBot Main App (port 3000).
//
// HONESTY & ISOLATION NOTE:
// The Main App holds ONLY the agent key (wallets.agent.json) and public addresses (wallets.public.json).
// It has NO database credentials and NO policy or owner keys.
// All policy state and transaction history come from GET /state on the independent Policy Service (port 4000).
// /api/approve/:id, /api/reject/:id, and /api/policy are thin proxies to the Policy Service's /owner/*
// endpoints, forwarding the x-owner-passcode header from the browser without ever storing it.

require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const {
  getState,
  getTx,
  getXrplProof,
  submitAgentSoloSignDemo,
  proxyOwnerApprove,
  proxyOwnerReject,
  proxyOwnerPolicy,
  loadPublicWallets,
  closeXrplClient,
} = require('./policy-client');
const { setLevel, getResource } = require('./resources');
const {
  emitter: monitorEmitter,
  start: startMonitor,
  stop: stopMonitor,
  getSnapshot,
  checkNow,
  resetLatch,
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
 * Loads public wallet addresses from wallets.public.json for UI display.
 */
function getPublicWallets() {
  try {
    const raw = loadPublicWallets();
    return {
      issuerAddress: raw?.issuer?.address || null,
      treasuryAddress: raw?.treasury?.address || null,
      utilityAddress: raw?.utility?.address || null,
      agentAddress: raw?.agent?.address || null,
      policyAddress: raw?.policy?.address || null,
      ownerAddress: raw?.owner?.address || null,
    };
  } catch (err) {
    return {
      issuerAddress: null,
      treasuryAddress: null,
      utilityAddress: null,
      agentAddress: null,
      policyAddress: null,
      ownerAddress: null,
    };
  }
}

/**
 * Builds the complete application state for GET /api/state and initial WS connection
 * by querying GET /state on the Policy Service.
 */
async function buildFullState() {
  const levels = getSnapshot();
  const policyState = await getState();
  const policy = policyState.policy;
  const spent = Number(policyState.spentToday || 0);
  const dailyCap = Number(policy.daily_cap);
  const budgetRemaining =
    policyState.budgetRemaining !== undefined
      ? Number(policyState.budgetRemaining)
      : Math.max(0, Math.round((dailyCap - spent) * 1e6) / 1e6);

  const rawTransactions = policyState.transactions || [];
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
 * Broadcasts budget + recent transactions by querying GET /state on the Policy Service.
 */
async function broadcastBudgetAndTxUpdate(triggerReason = 'update') {
  try {
    const policyState = await getState();
    const policy = policyState.policy;
    const spent = Number(policyState.spentToday || 0);
    const dailyCap = Number(policy.daily_cap);
    const budgetRemaining =
      policyState.budgetRemaining !== undefined
        ? Number(policyState.budgetRemaining)
        : Math.max(0, Math.round((dailyCap - spent) * 1e6) / 1e6);

    const transactions = (policyState.transactions || []).map(decorateTx);

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

    return { policy, spentToday: spent, budgetRemaining, transactions };
  } catch (err) {
    console.error('[Server] Failed to broadcast budget/tx update:', err.message);
    return null;
  }
}

// ============================================================================
// Wire Monitor & Agent Events -> WebSocket Broadcasts
// ============================================================================

monitorEmitter.on('level', (levels) => {
  broadcast('levels', { levels });
});

const activeLowHandlers = new Set();

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

agentEvents.on('decision', async (result) => {
  const txHash = result?.payment?.txHash || null;
  const isDeduped = Boolean(result?.payment?.deduped);

  const enrichedResult = {
    ...result,
    payment: result.payment
      ? {
          ...result.payment,
          explorerUrl: explorerUrl(txHash),
        }
      : null,
  };

  // Only broadcast decision & re-fetch transactions if this wasn't a silent 60s deduped rogue tick
  if (!isDeduped) {
    broadcast('decision', {
      decision: enrichedResult,
      levels: getSnapshot(),
    });
  }

  broadcast('levels', { levels: getSnapshot() });

  if (isDeduped) {
    return;
  }

  const latestState = await broadcastBudgetAndTxUpdate('agent_decision');

  // Send Telegram notification if configured
  try {
    const payStatus = result?.payment?.status;
    const proposal = result?.proposal || {};

    if (payStatus === 'pending_owner' && result?.payment?.id !== undefined) {
      await notifyPendingOwner({
        id: result.payment.id,
        resource: proposal.resource,
        amount: proposal.amount,
        reason: proposal.reason,
        blockedReason: result.payment.reason,
        remainingBudget: latestState?.budgetRemaining,
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

app.get('/api/state', async (req, res) => {
  try {
    const state = await buildFullState();
    res.json({ ok: true, ...state });
  } catch (err) {
    console.error('[GET /api/state] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Part 5a: Read-only XRPL on-ledger proof (no keys required)
app.get('/api/xrpl-proof', async (req, res) => {
  try {
    const proof = await getXrplProof();
    res.json({ ok: true, ...proof });
  } catch (err) {
    console.error('[GET /api/xrpl-proof] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// /api/demo/* routes stay open (demo only)
// Part 5b: Agent attempts to sign & submit a 1 RLUSD Payment alone (expect tefBAD_QUORUM)
app.post('/api/demo/solo-sign', async (req, res) => {
  try {
    const result = await submitAgentSoloSignDemo();
    res.json(result);
  } catch (err) {
    console.error('[POST /api/demo/solo-sign] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/demo/drain/:resource', (req, res) => {
  try {
    const resourceId = req.params.resource;
    getResource(resourceId);

    const newLevel = setLevel(resourceId, 6);
    const levels = checkNow();

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

app.post('/api/demo/reset', async (req, res) => {
  try {
    setRogueMode(false);
    setLevel('electricity', 100);
    setLevel('data', 100);
    resetLatch();
    const levels = getSnapshot();
    broadcast('levels', { levels });

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

/**
 * POST /api/policy -> Thin proxy to Policy Service POST /owner/policy.
 * Forwards x-owner-passcode header from the browser (never stored on the main app).
 */
app.post('/api/policy', async (req, res) => {
  try {
    const passcode = req.headers['x-owner-passcode'] || '';
    const { status, ok, data } = await proxyOwnerPolicy(req.body, passcode);

    if (!ok) {
      return res.status(status).json({
        ok: false,
        error: data?.error || data?.reason || 'Policy update rejected by policy service',
      });
    }

    await broadcastBudgetAndTxUpdate('policy_updated');

    res.json({
      ok: true,
      policy: data.policy,
      spentToday: data.spentToday,
      budgetRemaining: data.budgetRemaining,
    });
  } catch (err) {
    console.error('[POST /api/policy] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/approve/:id -> Thin proxy to Policy Service POST /owner/approve/:id.
 * Forwards x-owner-passcode header from the browser (never stored on the main app).
 */
app.post('/api/approve/:id', async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const passcode = req.headers['x-owner-passcode'] || '';

    const txBefore = await getTx(txId);
    const { status, ok, data: approveResult } = await proxyOwnerApprove(txId, passcode);

    if (status === 401) {
      return res.status(401).json({
        ok: false,
        error: approveResult?.error || 'Unauthorized: invalid x-owner-passcode',
      });
    }

    let vendResult = null;
    if (ok && approveResult.status === 'owner_approved') {
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

    res.status(status).json({
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

/**
 * POST /api/reject/:id -> Thin proxy to Policy Service POST /owner/reject/:id.
 * Forwards x-owner-passcode header from the browser (never stored on the main app).
 */
app.post('/api/reject/:id', async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const passcode = req.headers['x-owner-passcode'] || '';

    const { status, ok, data } = await proxyOwnerReject(txId, passcode);
    if (!ok) {
      return res.status(status).json({
        ok: false,
        error: data?.error || data?.reason || 'Reject failed',
      });
    }

    await broadcastBudgetAndTxUpdate('owner_reject');
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[POST /api/reject/:id] Error:', err.message);
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
    console.log(`GridBot Main App running at http://localhost:${PORT}`);
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
