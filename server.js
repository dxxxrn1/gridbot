// server.js
// Express + WebSocket (ws) backend for the GridBot Main App (port 3000).
//
// HONESTY & ISOLATION NOTE:
// The Main App holds ONLY the agent key (wallets.agent.json) and public addresses (wallets.public.json).
// It has NO database credentials and NO policy or owner keys.
// All policy state and transaction history come from GET /state on the independent Policy Service (port 4000).
// /api/approve/:id, /api/reject/:id, and /api/policy are thin proxies to the Policy Service's /owner/*
// endpoints, forwarding the x-owner-passcode header from the browser without ever storing it.

require("dotenv").config();
const http = require("http");
const path = require("path");
const { spawn, execSync } = require("child_process");
const express = require("express");
const WebSocket = require("ws");

const {
  getState,
  getTx,
  requestPayment,
  getXrplProof,
  submitAgentSoloSignDemo,
  proxyOwnerApprove,
  proxyOwnerReject,
  proxyOwnerPolicy,
  proxyStartNewDemoDay,
  listStaff,
  createStaff,
  deleteStaff,
  loadPublicWallets,
  closeXrplClient,
} = require("./policy-client");
const { setLevel, getResource } = require("./resources");
const {
  emitter: monitorEmitter,
  start: startMonitor,
  stop: stopMonitor,
  getSnapshot,
  checkNow,
  resetLatch,
  setCooldown,
} = require("./monitor");
const {
  handleLow,
  handleStaffRequest,
  STAFF_SKU_CATALOG,
  setRogueMode,
  isRogueMode,
  handleRedTeamRequest,
  agentEvents,
} = require("./agent");
const {
  login: authLogin,
  logout: authLogout,
  getUserFromReq,
  requireAuth,
  requireOwner,
} = require("./auth");
const {
  initTelegram,
  sendTelegramMessage,
  deleteTelegramMessage,
  getOwnerMenuInlineKeyboard,
  notifyLowWarning,
  notifyPendingOwner,
  notifyAutoApproved,
} = require("./telegram");

const PORT = Number(process.env.PORT) || 3000;
const DEMO_MODE = String(process.env.DEMO_MODE || "").trim().toLowerCase() === "true";
const XRPL_EXPLORER_BASE =
  process.env.XRPL_EXPLORER_BASE || "https://testnet.xrpl.org/transactions";

/**
 * Explorer link helper: https://testnet.xrpl.org/transactions/{hash}
 */
function explorerUrl(txHash) {
  if (!txHash) return null;
  return `${XRPL_EXPLORER_BASE.replace(/\/$/, "")}/${txHash}`;
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
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
wss.on("error", () => {
  // Handled by server.on('error')
});

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
    demoMode: DEMO_MODE,
    treasuryAddress: wallets.treasuryAddress,
    utilityAddress: wallets.utilityAddress,
    wallets,
    transactions,
  };
}

/**
 * Broadcasts budget + recent transactions by querying GET /state on the Policy Service.
 */
async function broadcastBudgetAndTxUpdate(triggerReason = "update") {
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

    broadcast("budget", {
      policy,
      spentToday: spent,
      budgetRemaining,
    });

    broadcast("transactions", {
      reason: triggerReason,
      transactions,
      spentToday: spent,
      budgetRemaining,
    });

    return { policy, spentToday: spent, budgetRemaining, transactions };
  } catch (err) {
    console.error(
      "[Server] Failed to broadcast budget/tx update:",
      err.message,
    );
    return null;
  }
}

// ============================================================================
// Wire Monitor & Agent Events -> WebSocket Broadcasts
// ============================================================================

monitorEmitter.on("level", (levels) => {
  broadcast("levels", { levels });
});

monitorEmitter.on("warning", async (warnEvent) => {
  broadcast("warn_alert", warnEvent);
  try {
    await notifyLowWarning(warnEvent);
  } catch (err) {
    console.warn("[Server -> Telegram] Low warning error:", err.message);
  }
});

const activeLowHandlers = new Set();

monitorEmitter.on("low", async (lowEvent) => {
  const resourceId = lowEvent.id;
  if (activeLowHandlers.has(resourceId)) return;
  activeLowHandlers.add(resourceId);

  broadcast("low_alert", {
    resource: resourceId,
    label: lowEvent.label,
    level: lowEvent.level,
    threshold: lowEvent.threshold,
  });

  try {
    const result = await handleLow(lowEvent);
    const payStatus = result?.payment?.status;
    if (payStatus === "pending_owner" || payStatus === "blocked") {
      setCooldown(resourceId, 120000);
    }
  } catch (err) {
    console.error(
      `[Server] Error in agent.handleLow(${resourceId}):`,
      err.message,
    );
    broadcast("agent_error", {
      resource: resourceId,
      error: err.message,
    });
  } finally {
    activeLowHandlers.delete(resourceId);
  }
});

agentEvents.on("decision", async (result) => {
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
    broadcast("decision", {
      decision: enrichedResult,
      levels: getSnapshot(),
    });
  }

  broadcast("levels", { levels: getSnapshot() });

  if (isDeduped) {
    return;
  }

  const latestState = await broadcastBudgetAndTxUpdate("agent_decision");

  // Send Telegram notification if configured
  try {
    const payStatus = result?.payment?.status;
    const proposal = result?.proposal || {};

    if (payStatus === "pending_owner" && result?.payment?.id !== undefined) {
      await notifyPendingOwner({
        id: result.payment.id,
        resource: proposal.resource,
        amount: proposal.amount,
        reason: proposal.reason,
        blockedReason: result.payment.reason,
        remainingBudget: latestState?.budgetRemaining,
        requestedBy: result.requestedBy || "Autonomous Monitor",
      });
    } else if (payStatus === "auto_approved") {
      await notifyAutoApproved({
        resource: proposal.resource,
        amount: proposal.amount,
        reason: proposal.reason,
        txHash,
        vend: result.vend,
        requestedBy: result.requestedBy || "Autonomous Monitor",
      });
    }
  } catch (tgErr) {
    console.error("[Server -> Telegram] Notification error:", tgErr.message);
  }
});

agentEvents.on("rogue", ({ rogueMode }) => {
  broadcast("rogue", { rogueMode });
});

// ============================================================================
// Auth & Staff Request Endpoints
// ============================================================================

app.post("/api/auth/login", async (req, res) => {
  try {
    const result = await authLogin(req.body || {});
    if (!result.ok) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  authLogout(req);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const user = getUserFromReq(req);
  if (!user) {
    return res.status(401).json({ ok: false, user: null });
  }
  res.json({ ok: true, user });
});

/**
 * Staff Management API Endpoints
 */
app.get("/api/staff", requireAuth, async (req, res) => {
  try {
    const staff = await listStaff();
    res.json({ ok: true, staff });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/staff", requireOwner, async (req, res) => {
  try {
    const passcode = req.headers["x-owner-passcode"] || "";
    const { status, ok, data } = await createStaff(req.body, passcode);
    res
      .status(status || (ok ? 200 : 400))
      .json(data || { ok, error: "Staff creation failed" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/staff/:id", requireOwner, async (req, res) => {
  try {
    const passcode = req.headers["x-owner-passcode"] || "";
    const { status, ok, data } = await deleteStaff(req.params.id, passcode);
    res
      .status(status || (ok ? 200 : 400))
      .json(data || { ok, error: "Staff deletion failed" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/staff/request", requireAuth, async (req, res) => {
  try {
    const { requestText } = req.body || {};
    if (
      !requestText ||
      typeof requestText !== "string" ||
      !requestText.trim()
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Please enter a plain-language operational request (e.g. "Meter is beeping, need electricity token").',
      });
    }

    const result = await handleStaffRequest({
      staffUser: req.user,
      requestText: requestText.trim(),
    });

    const txHash = result?.payment?.txHash || null;
    res.json({
      ok: true,
      mode: result.mode,
      requestedBy: result.requestedBy,
      staffUser: result.staffUser,
      proposal: result.proposal,
      payment: result.payment
        ? {
            ...result.payment,
            explorerUrl: explorerUrl(txHash),
          }
        : null,
      vend: result.vend,
      proofLotEvidence: result.proofLotEvidence,
      levels: getSnapshot(),
    });
  } catch (err) {
    console.error("[POST /api/staff/request] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/demo/red-team", requireOwner, async (req, res) => {
  if (!DEMO_MODE) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  try {
    const result = await handleRedTeamRequest();
    await broadcastBudgetAndTxUpdate("red_team_test");
    res.json({
      ok: true,
      requestText: result.requestText,
      actualAiProposal: result.actualAiProposal,
      attackProposal: result.attackProposal,
      payment: result.payment,
      auditLogged: result.payment?.id !== undefined && result.payment?.id !== null,
      signatureObtained: result.signatureObtained,
    });
  } catch (err) {
    console.error("[POST /api/demo/red-team] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// REST API Endpoints
// ============================================================================

app.get("/api/state", async (req, res) => {
  try {
    const state = await buildFullState();
    res.json({
      ok: true,
      ...state,
      skuCatalog: STAFF_SKU_CATALOG,
      currentUser: getUserFromReq(req),
    });
  } catch (err) {
    console.error("[GET /api/state] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Part 5a: Read-only XRPL on-ledger proof (no keys required)
app.get("/api/xrpl-proof", async (req, res) => {
  try {
    const proof = await getXrplProof();
    res.json({ ok: proof.ok !== false, ...proof });
  } catch (err) {
    console.error("[GET /api/xrpl-proof] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// /api/demo/* routes stay open (demo only)
// Part 5b: Agent attempts to sign & submit a 1 RLUSD Payment alone (expect tefBAD_QUORUM)
app.post("/api/demo/solo-sign", async (req, res) => {
  try {
    const result = await submitAgentSoloSignDemo();
    res.json(result);
  } catch (err) {
    console.error("[POST /api/demo/solo-sign] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/demo/drain/:resource", (req, res) => {
  try {
    const resourceId = req.params.resource;
    getResource(resourceId);

    const newLevel = setLevel(resourceId, 4);
    const levels = checkNow();

    res.json({
      ok: true,
      resource: resourceId,
      level: newLevel,
      levels,
    });
  } catch (err) {
    console.error("[POST /api/demo/drain/:resource] Error:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/demo/rogue", (req, res) => {
  try {
    const nextState =
      typeof req.body?.enabled === "boolean"
        ? req.body.enabled
        : !isRogueMode();
    const rogueMode = setRogueMode(nextState);

    res.json({
      ok: true,
      rogueMode,
    });
  } catch (err) {
    console.error("[POST /api/demo/rogue] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/demo/reset", async (req, res) => {
  try {
    setRogueMode(false);
    setLevel("electricity", 100);
    setLevel("data", 100);
    resetLatch();
    const levels = getSnapshot();
    broadcast("levels", { levels });

    res.json({
      ok: true,
      rogueMode: false,
      levels,
    });
  } catch (err) {
    console.error("[POST /api/demo/reset] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/policy -> Thin proxy to Policy Service POST /owner/policy.
 * Protected by requireOwner (accepts either x-owner-passcode OR an authenticated owner session token).
 */
app.post("/api/policy", requireOwner, async (req, res) => {
  try {
    const passcode = req.headers["x-owner-passcode"] || "";
    const { status, ok, data } = await proxyOwnerPolicy(req.body, passcode);

    if (!ok) {
      return res.status(status).json({
        ok: false,
        error:
          data?.error ||
          data?.reason ||
          "Policy update rejected by policy service",
      });
    }

    await broadcastBudgetAndTxUpdate("policy_updated");
    if (Number(data.budgetRemaining) > 0) {
      resetLatch();
      setTimeout(() => {
        try {
          checkNow();
        } catch (_) {}
      }, 250);
    }

    res.json({
      ok: true,
      policy: data.policy,
      spentToday: data.spentToday,
      budgetRemaining: data.budgetRemaining,
    });
  } catch (err) {
    console.error("[POST /api/policy] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/freeze -> Owner-only instant Freeze toggle.
 */
app.post("/api/freeze", requireOwner, async (req, res) => {
  try {
    const passcode = (req.headers["x-owner-passcode"] || "").trim();
    const frozen = Boolean(req.body?.frozen);
    const { status, ok, data } = await proxyOwnerPolicy({ frozen }, passcode);
    if (!ok) {
      return res.status(status).json({
        ok: false,
        error: data?.error || "Unauthorized or failed to toggle freeze",
      });
    }
    await broadcastBudgetAndTxUpdate(
      frozen ? "owner_freeze_on" : "owner_freeze_off",
    );
    await sendTelegramMessage(
      frozen
        ? "🧊 *GridBot Frozen from Dashboard:* All spending is paused immediately."
        : "▶️ *GridBot Unfrozen from Dashboard:* Spending resumed within policy caps.",
    ).catch(() => {});

    res.json({
      ok: true,
      frozen: Boolean(data.policy?.frozen),
      policy: data.policy,
    });
  } catch (err) {
    console.error("[POST /api/freeze] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/trust-center -> Read-only Trust Center endpoint (accessible to everyone).
 */
app.get("/api/trust-center", async (req, res) => {
  try {
    const [proof, state] = await Promise.all([
      getXrplProof().catch((err) => ({ error: err.message })),
      getState(),
    ]);

    const allTx = Array.isArray(state?.transactions) ? state.transactions : [];
    const recentBlocked = allTx
      .filter((tx) => tx.status === "blocked")
      .slice(0, 10)
      .map((tx) => ({
        id: tx.id,
        ts: tx.ts,
        resource: tx.resource,
        amount: tx.amount,
        payee: tx.payee,
        reason: tx.reason,
        ruleTriggered: tx.blocked_reason || "Blocked by Policy Signer",
      }));

    res.json({
      ok: true,
      guarantee: "The AI can propose, it cannot pay alone",
      enforcementModel: {
        onChain:
          "XRPL Testnet Multi-Sign (SignerQuorum: 2, Master Key Disabled via lsfDisableMaster)",
        offChain:
          "Isolated Policy Service (Port 4000) enforcing daily cap, per-payment cap, allowlist, velocity limit, and Owner Freeze",
      },
      policy: state?.policy || {},
      ledgerProof: proof,
      recentBlocked,
    });
  } catch (err) {
    console.error("[GET /api/trust-center] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/policy/start-demo-day", requireOwner, async (req, res) => {
  try {
    const passcode = req.headers["x-owner-passcode"] || "";
    const { status, ok, data } = await proxyStartNewDemoDay(passcode);
    if (!ok) {
      return res.status(status).json({
        ok: false,
        error: data?.error || "Unable to start a new demo day",
      });
    }

    await broadcastBudgetAndTxUpdate("demo_day_started");
    res.json({
      ok: true,
      policy: data.policy,
      spentToday: data.spentToday,
      budgetRemaining: data.budgetRemaining,
    });
  } catch (err) {
    console.error("[POST /api/policy/start-demo-day] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/approve/:id -> Thin proxy to Policy Service POST /owner/approve/:id.
 * Protected by requireOwner (accepts either x-owner-passcode OR an authenticated owner session token).
 */
app.post("/api/approve/:id", requireOwner, async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const passcode = req.headers["x-owner-passcode"] || "";

    const txBefore = await getTx(txId);
    const {
      status,
      ok,
      data: approveResult,
    } = await proxyOwnerApprove(txId, passcode);

    if (status === 401) {
      return res.status(401).json({
        ok: false,
        error: approveResult?.error || "Unauthorized: invalid x-owner-passcode",
      });
    }

    let vendResult = null;
    if (ok && approveResult.status === "owner_approved") {
      try {
        const plugin = getResource(txBefore.resource);
        vendResult = plugin.vend(txBefore.amount);
        resetLatch(txBefore.resource);
        broadcast("levels", { levels: getSnapshot() });
      } catch (vendErr) {
        console.warn(
          "[POST /api/approve/:id] Resource vend warning:",
          vendErr.message,
        );
      }
    }

    const updatedTx = decorateTx(await getTx(txId));
    await broadcastBudgetAndTxUpdate("owner_approve");

    broadcast("owner_approved", {
      transaction: updatedTx,
      approveResult: {
        ...approveResult,
        explorerUrl: explorerUrl(approveResult.txHash),
      },
      vend: vendResult,
    });

    res.status(status).json({
      ok: approveResult.status === "owner_approved",
      ...approveResult,
      explorerUrl: explorerUrl(approveResult.txHash),
      transaction: updatedTx,
      vend: vendResult,
    });
  } catch (err) {
    console.error("[POST /api/approve/:id] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/reject/:id -> Thin proxy to Policy Service POST /owner/reject/:id.
 * Protected by requireOwner (accepts either x-owner-passcode OR an authenticated owner session token).
 */
app.post("/api/reject/:id", requireOwner, async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const passcode = req.headers["x-owner-passcode"] || "";

    const { status, ok, data } = await proxyOwnerReject(txId, passcode);
    if (!ok) {
      return res.status(status).json({
        ok: false,
        error: data?.error || data?.reason || "Reject failed",
      });
    }

    await broadcastBudgetAndTxUpdate("owner_reject");
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("[POST /api/reject/:id] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// WebSocket Connection Handler
// ============================================================================

wss.on("connection", async (ws) => {
  try {
    const state = await buildFullState();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "init",
          ts: new Date().toISOString(),
          ...state,
        }),
      );
    }
  } catch (err) {
    console.error(
      "[WS connection init] Error sending initial state:",
      err.message,
    );
  }
});

// ============================================================================
// Server Startup & Graceful Shutdown
// ============================================================================

let spawnedPolicyProcess = null;

/**
 * Ensures the independent Policy Service (port 4000) is running.
 * If it is not already running in a second terminal, spawns `node policy-service/server.js`
 * as a separate OS child process so `node server.js` works out-of-the-box in one terminal.
 */
async function ensurePolicyServiceRunning() {
  const policyUrl = (
    process.env.POLICY_SERVICE_URL || "http://localhost:4000"
  ).replace(/\/$/, "");
  const token = (process.env.AGENT_API_TOKEN || "").trim();

  try {
    const probe = await fetch(`${policyUrl}/state`, {
      headers: { "x-agent-token": token },
    });
    if (probe.ok || probe.status === 401) {
      return;
    }
  } catch (_) {
    // Policy Service not running yet — spawn it as a separate OS process
  }

  const policyDir = path.join(__dirname, "policy-service");
  const policyEntry = path.join(policyDir, "server.js");
  console.log(
    "[Server] Spawning isolated Policy Service process (port 4000)...",
  );

  spawnedPolicyProcess = spawn(process.execPath, [policyEntry], {
    cwd: policyDir,
    stdio: "inherit",
    env: { ...process.env, PORT: "4000" },
  });

  spawnedPolicyProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(
        `[Server] Policy Service child process exited with code ${code}`,
      );
    }
    spawnedPolicyProcess = null;
  });

  // Wait up to 2.5s for port 4000 to start accepting requests
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const check = await fetch(`${policyUrl}/state`, {
        headers: { "x-agent-token": token },
      });
      if (check.ok || check.status === 401) {
        break;
      }
    } catch (_) {}
  }
}

/**
 * Frees a TCP port on Windows if an older Node process from a previous terminal is still holding it.
 */
async function freePortIfInUse(port) {
  let killed = false;
  try {
    const out = execSync(`netstat -ano`, { encoding: "utf8" });
    const lines = out
      .split(/\r?\n/)
      .filter((l) => l.includes("LISTENING") && l.includes(`:${port}`));
    const pids = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid && pid !== process.pid) {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      console.log(
        `[Server] Stopping previous process on port ${port} (PID ${pid})...`,
      );
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
        killed = true;
      } catch (_) {}
    }
  } catch (_) {}

  if (killed) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function startServer() {
  await freePortIfInUse(PORT);
  await freePortIfInUse(4000);
  await ensurePolicyServiceRunning();

  initTelegram({
    onStateChanged: async (evt) => {
      if (evt.type === "proactive_topup" && evt.resource) {
        const isData = evt.resource === "data";
        const amount = isData ? 3 : 5;
        const reason = isData
          ? "Owner Telegram proactive top-up: 3 RLUSD emergency LTE data"
          : "Owner Telegram proactive top-up: 5 RLUSD prepaid electricity token";

        try {
          const state = await getState();
          const pubWallets = loadPublicWallets();
          const payee =
            state?.policy?.allowed_payees?.[0] || pubWallets?.utility?.address;
          let paymentResult = await requestPayment({
            resource: evt.resource,
            amount,
            payee,
            reason,
            requestedBy: "owner:telegram_topup",
          });

          if (
            paymentResult?.status === "pending_owner" &&
            paymentResult?.id !== undefined &&
            paymentResult?.id !== null &&
            evt.telegramAuth?.pin
          ) {
            const overrideRes = await proxyOwnerApprove(
              paymentResult.id,
              null,
              evt.telegramAuth,
            );
            if (
              overrideRes.ok &&
              overrideRes.data?.status === "owner_approved"
            ) {
              paymentResult = {
                ...overrideRes.data,
                id: paymentResult.id,
                ownerOverride: true,
              };
            }
          }

          let vend = null;
          if (
            paymentResult?.status === "auto_approved" ||
            paymentResult?.status === "owner_approved"
          ) {
            const targetPlugin = getResource(evt.resource);
            vend = targetPlugin.vend(amount);
            resetLatch(evt.resource);
          }

          const latestLevels = getSnapshot();
          broadcast("levels", { levels: latestLevels });
          const latestState = await broadcastBudgetAndTxUpdate(
            "telegram_proactive_topup",
          );

          const decisionDecision =
            paymentResult?.status === "auto_approved" ||
            paymentResult?.status === "owner_approved"
              ? "buy"
              : paymentResult?.status === "pending_owner"
                ? "escalate"
                : "wait";

          broadcast("decision", {
            decision: {
              mode: "telegram_owner",
              timestamp: new Date().toISOString(),
              requestedBy: "Owner (Telegram Top-Up)",
              proposal: {
                decision: decisionDecision,
                resource: evt.resource,
                amount,
                reason,
              },
              payment: paymentResult
                ? {
                    ...paymentResult,
                    explorerUrl: explorerUrl(paymentResult.txHash),
                  }
                : null,
              vend,
            },
            levels: latestLevels,
          });

          if (paymentResult?.status === "owner_approved") {
            const updatedTx = paymentResult?.id
              ? decorateTx(await getTx(paymentResult.id))
              : null;
            broadcast("owner_approved", {
              transaction: updatedTx,
              approveResult: {
                ...paymentResult,
                explorerUrl: explorerUrl(paymentResult?.txHash),
              },
              vend,
            });
          }

          let notifyRes = null;
          if (
            paymentResult?.status === "auto_approved" ||
            paymentResult?.status === "owner_approved"
          ) {
            notifyRes = await notifyAutoApproved({
              title: paymentResult.ownerOverride
                ? "✅ *GridBot Owner Telegram Override Settled*"
                : "✅ *GridBot Owner Telegram Top-Up Settled*",
              resource: evt.resource,
              amount,
              reason,
              txHash: paymentResult.txHash,
              vend,
              requestedBy: paymentResult.ownerOverride
                ? "Owner Override (Weight-2 Multi-Sig)"
                : "Owner (Telegram Top-Up)",
            });
          } else if (paymentResult?.status === "pending_owner") {
            if (paymentResult?.id !== undefined && paymentResult?.id !== null) {
              notifyRes = await notifyPendingOwner({
                id: paymentResult.id,
                resource: evt.resource,
                amount,
                reason,
                blockedReason: paymentResult.reason,
                remainingBudget: latestState?.budgetRemaining,
                requestedBy: "Owner (Telegram Top-Up)",
              });
            } else {
              const pendingMsg =
                paymentResult?.reason ||
                "Daily budget exhausted; check Pending Approvals.";
              notifyRes = await sendTelegramMessage(
                `⏳ *Top-Up Pending Owner Approval:* ${String(pendingMsg).replace(/[_*`[\]]/g, "")}`,
                { reply_markup: getOwnerMenuInlineKeyboard() },
              );
            }
          } else {
            const blockReason =
              paymentResult?.reason || "Top-up blocked by policy service.";
            notifyRes = await sendTelegramMessage(
              `❌ *Proactive Top-Up Blocked:* ${String(blockReason).replace(/[_*`[\]]/g, "")}`,
              { reply_markup: getOwnerMenuInlineKeyboard() },
            );
          }

          if (notifyRes?.ok && evt.processingMsgId) {
            await deleteTelegramMessage(evt.chatId, evt.processingMsgId);
          }
        } catch (err) {
          console.error(
            "[Server -> Telegram proactive_topup] Error:",
            err.message,
          );
          const errRes = await sendTelegramMessage(
            `❌ *Proactive Top-Up Error:* ${String(err.message).replace(/[_*`[\]]/g, "")}`,
            { reply_markup: getOwnerMenuInlineKeyboard() },
          );
          if (errRes?.ok && evt.processingMsgId) {
            await deleteTelegramMessage(evt.chatId, evt.processingMsgId);
          }
        }
        return;
      }

      broadcast("levels", { levels: getSnapshot() });
      await broadcastBudgetAndTxUpdate(`telegram_${evt.type}`);
      if (evt.type === "owner_approved") {
        const updatedTx = decorateTx(await getTx(evt.txId));
        resetLatch(updatedTx?.resource || evt.resource);
        broadcast("owner_approved", {
          source: "telegram",
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

  let retries = 0;
  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE" && retries < 3) {
      retries += 1;
      console.warn(
        `[Server] Port ${PORT} still busy, freeing and retrying (${retries}/3)...`,
      );
      await freePortIfInUse(PORT);
      setTimeout(() => {
        server.close();
        server.listen(PORT);
      }, 500);
    } else {
      console.error("[Server] Fatal listen error:", err.message);
    }
  });

  server.listen(PORT, () => {
    console.log(`GridBot Main App running at http://localhost:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

process.on("SIGINT", async () => {
  stopMonitor();
  setRogueMode(false);
  if (spawnedPolicyProcess) {
    spawnedPolicyProcess.kill("SIGINT");
  }
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
