const assert = require('node:assert/strict');
const test = require('node:test');

const dbPath = require.resolve('./policy-service/db');
const previousDbModule = require.cache[dbPath];
const loggedRows = [];
let policy = {};
let staffDailyCap = null;
let staffSpentToday = 0;

const fakeDb = {
  loadPublicWallets: () => ({
    treasury: { address: 'rTreasury' },
    issuer: { address: 'rIssuer' },
  }),
  getPolicy: async () => policy,
  spentToday: async () => 0,
  getStaffDailyCap: async () => staffDailyCap,
  spentTodayForStaff: async () => staffSpentToday,
  findRecentPendingDuplicate: async () => null,
  findRecentVelocityBlocked: async () => null,
  logTx: async (row) => {
    const saved = { id: loggedRows.length + 1, ...row };
    loggedRows.push(saved);
    return saved;
  },
  updateTx: async () => null,
  getTx: async () => null,
  transitionPendingTx: async () => null,
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};
const { signAndSubmitAgentRequest, resetVelocityWindow } = require('./policy-service/signer');

function resetMocks() {
  loggedRows.length = 0;
  policy = {
    spending_frozen: false,
    daily_cap: 50,
    per_tx_cap: 20,
    allowed_payees: ['rUtility'],
  };
  staffDailyCap = null;
  staffSpentToday = 0;
  resetVelocityWindow();
}

test('owner freeze rejects a new policy request before signing', async () => {
  resetMocks();
  policy.spending_frozen = true;

  const result = await signAndSubmitAgentRequest({
    resource: 'electricity',
    reason: 'test request',
    requestedBy: 'staff:cashier',
    tx_json: {},
    agent_blob: 'not-used',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'Spending frozen by owner');
  assert.equal(loggedRows[0].blocked_reason, 'Spending frozen by owner');
});

test('staff daily cap is enforced by the Policy Service', async () => {
  resetMocks();
  staffDailyCap = 2;
  staffSpentToday = 1.5;

  const result = await signAndSubmitAgentRequest({
    resource: 'electricity',
    reason: '[Staff Request by Cashier (staff:cashier): "need electricity"]',
    requestedBy: 'staff:cashier',
    tx_json: {
      TransactionType: 'Payment',
      Account: 'rTreasury',
      Destination: 'rUtility',
      Amount: {
        currency: '524C555344000000000000000000000000000000',
        issuer: 'rIssuer',
        value: '1',
      },
    },
    agent_blob: 'agent-signature',
  });

  assert.equal(result.status, 'pending_owner');
  assert.match(result.reason, /Staff daily cap exceeded/);
  assert.equal(loggedRows[0].status, 'pending_owner');
  assert.match(loggedRows[0].blocked_reason, /staff_daily_cap 2 RLUSD/);
});

test.after(() => {
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
});
