// policy-service/server.js
// Express HTTP server (port 4000) for the isolated Policy Service.
// Holds the policy key, owner key, and Supabase credentials.
//
// Endpoints:
// - POST /sign               (header x-agent-token == AGENT_API_TOKEN)
// - POST /owner/approve/:id  (header x-owner-passcode == OWNER_PASSCODE)
// - POST /owner/reject/:id   (header x-owner-passcode == OWNER_PASSCODE)
// - POST /owner/policy       (header x-owner-passcode == OWNER_PASSCODE)
// - GET  /state              (header x-agent-token == AGENT_API_TOKEN)
// - GET  /tx/:id             (header x-agent-token == AGENT_API_TOKEN)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const {
  getPolicy,
  updatePolicy,
  spentToday,
  getTx,
  listTx,
  listStaffUsers,
  createStaffUser,
  deleteStaffUser,
  verifyStaffUser,
} = require('./db');
const {
  signAndSubmitAgentRequest,
  ownerApprove,
  ownerReject,
  closeXrplClient,
} = require('./signer');

const PORT = Number(process.env.PORT) || 4000;
const AGENT_API_TOKEN = (process.env.AGENT_API_TOKEN || '').trim();
const OWNER_PASSCODE = (process.env.OWNER_PASSCODE || '').trim();

if (!AGENT_API_TOKEN) {
  console.warn('[Policy Service] WARNING: AGENT_API_TOKEN is empty in policy-service/.env');
}
if (!OWNER_PASSCODE) {
  console.warn('[Policy Service] WARNING: OWNER_PASSCODE is empty in policy-service/.env');
}

const app = express();
app.use(express.json());

/**
 * Middleware: requires header `x-agent-token` to equal AGENT_API_TOKEN, else 401.
 */
function requireAgentToken(req, res, next) {
  const token = (req.headers['x-agent-token'] || '').trim();
  if (!AGENT_API_TOKEN || token !== AGENT_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing x-agent-token' });
  }
  next();
}

/**
 * Middleware: requires header `x-owner-passcode` to equal OWNER_PASSCODE, else 401.
 */
function requireOwnerPasscode(req, res, next) {
  const passcode = (req.headers['x-owner-passcode'] || '').trim();
  if (!OWNER_PASSCODE || passcode !== OWNER_PASSCODE) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing x-owner-passcode' });
  }
  next();
}

// ============================================================================
// Agent-Authenticated Endpoints
// ============================================================================

/**
 * POST /sign
 * Body: { resource, reason, tx_json, agent_blob }
 */
app.post('/sign', requireAgentToken, async (req, res) => {
  try {
    const { resource, reason, tx_json, agent_blob } = req.body || {};
    const result = await signAndSubmitAgentRequest({
      resource,
      reason,
      tx_json,
      agent_blob,
    });
    res.json(result);
  } catch (err) {
    console.error('[Policy Service POST /sign] Error:', err.message);
    res.status(500).json({
      status: 'blocked',
      reason: `Fail-safe server error: ${err.message}`,
    });
  }
});

/**
 * GET /state
 * Returns { policy, spentToday, budgetRemaining, transactions (latest 50) }
 */
app.get('/state', requireAgentToken, async (req, res) => {
  try {
    const policy = await getPolicy();
    const spent = await spentToday();
    const dailyCap = Number(policy.daily_cap);
    const budgetRemaining = Math.max(0, Math.round((dailyCap - spent) * 1e6) / 1e6);
    const transactions = await listTx(50);

    res.json({
      policy,
      spentToday: spent,
      budgetRemaining,
      transactions,
    });
  } catch (err) {
    console.error('[Policy Service GET /state] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /tx/:id
 * Returns the single transaction row.
 */
app.get('/tx/:id', requireAgentToken, async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const row = await getTx(txId);
    res.json(row);
  } catch (err) {
    console.error('[Policy Service GET /tx/:id] Error:', err.message);
    res.status(404).json({ error: err.message });
  }
});

/**
 * GET /staff
 * Returns active staff users.
 */
app.get('/staff', requireAgentToken, async (req, res) => {
  try {
    const staff = await listStaffUsers();
    res.json({ ok: true, staff });
  } catch (err) {
    console.error('[Policy Service GET /staff] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /auth/verify
 * Validates staff or owner credentials against Supabase / local DB.
 */
app.post('/auth/verify', requireAgentToken, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await verifyStaffUser(username, password);
    if (!result.ok) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[Policy Service POST /auth/verify] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// Owner-Authenticated Endpoints (x-owner-passcode)
// ============================================================================

/**
 * POST /owner/approve/:id
 * Builds & autofills a new Payment from treasury to stored payee and amount,
 * signs ONLY with the owner key (weight 2), submits, updates row to owner_approved.
 */
app.post('/owner/approve/:id', requireOwnerPasscode, async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const result = await ownerApprove(txId);
    const statusCode = result.status === 'owner_approved' ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (err) {
    console.error('[Policy Service POST /owner/approve/:id] Error:', err.message);
    res.status(500).json({
      status: 'blocked',
      reason: err.message,
    });
  }
});

/**
 * POST /owner/reject/:id
 * Marks status = 'blocked', blocked_reason = 'rejected by owner'.
 */
app.post('/owner/reject/:id', requireOwnerPasscode, async (req, res) => {
  try {
    const rawId = req.params.id;
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    const result = await ownerReject(txId);
    res.json(result);
  } catch (err) {
    console.error('[Policy Service POST /owner/reject/:id] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /owner/policy
 * Body: { daily_cap, per_tx_cap, allowed_payees }
 */
app.post('/owner/policy', requireOwnerPasscode, async (req, res) => {
  try {
    const { daily_cap, per_tx_cap, allowed_payees } = req.body || {};
    const updates = {};

    if (daily_cap !== undefined) {
      const n = Number(daily_cap);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: 'daily_cap must be a positive number' });
      }
      updates.daily_cap = n;
    }

    if (per_tx_cap !== undefined) {
      const n = Number(per_tx_cap);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: 'per_tx_cap must be a positive number' });
      }
      updates.per_tx_cap = n;
    }

    if (allowed_payees !== undefined) {
      if (
        !Array.isArray(allowed_payees) ||
        allowed_payees.length === 0 ||
        !allowed_payees.every((addr) => typeof addr === 'string' && addr.startsWith('r'))
      ) {
        return res
          .status(400)
          .json({ error: 'allowed_payees must be a non-empty array of XRPL addresses' });
      }
      updates.allowed_payees = allowed_payees;
    }

    const updatedPolicy = await updatePolicy(updates);
    const spent = await spentToday();
    const budgetRemaining = Math.max(
      0,
      Math.round((Number(updatedPolicy.daily_cap) - spent) * 1e6) / 1e6
    );

    res.json({
      ok: true,
      policy: updatedPolicy,
      spentToday: spent,
      budgetRemaining,
    });
  } catch (err) {
    console.error('[Policy Service POST /owner/policy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /owner/staff
 * Creates a new cashier or staff member in Supabase / local DB.
 */
app.post('/owner/staff', requireOwnerPasscode, async (req, res) => {
  try {
    const { username, displayName, passcode, role, shift } = req.body || {};
    const created = await createStaffUser({ username, displayName, passcode, role, shift });
    res.json({ ok: true, staff: created });
  } catch (err) {
    console.error('[Policy Service POST /owner/staff] Error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /owner/staff/:id
 * Deletes a staff member from Supabase / local DB.
 */
app.delete('/owner/staff/:id', requireOwnerPasscode, async (req, res) => {
  try {
    const rawId = req.params.id;
    const result = await deleteStaffUser(rawId);
    res.json(result);
  } catch (err) {
    console.error('[Policy Service DELETE /owner/staff/:id] Error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

function startPolicyServer(port = PORT) {
  const srv = app.listen(port, () => {
    console.log(`GridBot Policy Service running at http://localhost:${port}`);
  });
  return srv;
}

if (require.main === module) {
  startPolicyServer();
}

process.on('SIGINT', async () => {
  await closeXrplClient();
  process.exit(0);
});

module.exports = {
  app,
  startPolicyServer,
};
