const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = '123456:test_token_for_local_tests';
process.env.TELEGRAM_CHAT_ID = '-90001';
process.env.TELEGRAM_OWNER_USER_ID = '70001';
process.env.OWNER_PASSCODE = 'owner-passcode-for-local-tests';

const telegram = require('./telegram');

let originalFetch;
let transactions;
let sentMessages;
let callbackAnswers;
let approvalCalls;
let rejectCalls;
let topupResult;
let updateResponse;
let webhookUrl;
let deleteWebhookBody;
let webhookDeleteFails;
let pollBodies;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function installMockFetch() {
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    const body = options.body ? JSON.parse(options.body) : {};

    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      if (method === 'answerCallbackQuery') callbackAnswers.push(body);
      if (method === 'sendMessage') sentMessages.push(body.text);
      if (method === 'getUpdates') {
        pollBodies.push(body);
        return jsonResponse(updateResponse || { ok: true, result: [] });
      }
      if (method === 'getWebhookInfo') return jsonResponse({ ok: true, result: { url: webhookUrl || '' } });
      if (method === 'deleteWebhook') {
        deleteWebhookBody = body;
        return webhookDeleteFails
          ? jsonResponse({ ok: false, description: 'Conflict while removing webhook' }, 409)
          : jsonResponse({ ok: true, result: true });
      }
      if (method === 'getMe') return jsonResponse({ ok: true, result: { is_bot: true } });
      return jsonResponse({ ok: true, result: { message_id: 44, is_bot: true } });
    }

    if (/\/tx\/\d+$/.test(url)) {
      const id = Number(url.split('/').pop());
      const tx = transactions.get(id);
      return tx ? jsonResponse(tx) : jsonResponse({ error: 'Not found' }, 404);
    }
    if (url.endsWith('/state')) {
      return jsonResponse({
        policy: { daily_cap: 150, per_tx_cap: 5, allowed_payees: [] },
        spentToday: 0,
        budgetRemaining: 150,
        transactions: [...transactions.values()],
      });
    }
    if (/\/owner\/approve\/\d+$/.test(url)) {
      approvalCalls += 1;
      const id = Number(url.split('/').pop());
      const tx = transactions.get(id);
      if (!tx || tx.status !== 'pending_owner') {
        return jsonResponse({ status: tx?.status || 'missing', reason: 'not pending' }, 400);
      }
      tx.status = 'owner_approved';
      tx.tx_hash = 'TESTNET_HASH';
      return jsonResponse({ status: 'owner_approved', txHash: tx.tx_hash });
    }
    if (/\/owner\/reject\/\d+$/.test(url)) {
      rejectCalls += 1;
      const id = Number(url.split('/').pop());
      const tx = transactions.get(id);
      if (!tx || tx.status !== 'pending_owner') {
        return jsonResponse({ status: tx?.status || 'missing', reason: 'not pending' }, 400);
      }
      tx.status = 'blocked';
      tx.blocked_reason = 'rejected by owner';
      return jsonResponse({ status: 'blocked', reason: 'rejected by owner' });
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  };
}

function tx(id, status = 'pending_owner') {
  return {
    id,
    status,
    resource: 'electricity',
    amount: 5,
    reason: '[Staff Request by Demo Staff (staff:demo): "Electricity is low"]',
    blocked_reason: 'daily cap exceeded',
    tx_hash: null,
  };
}

function callback(data, userId = 70001, updateId = 1) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: userId },
      message: { message_id: 33, chat: { id: -90001 } },
      data,
    },
  };
}

test.beforeEach(() => {
  originalFetch = global.fetch;
  transactions = new Map([[1, tx(1)]]);
  sentMessages = [];
  callbackAnswers = [];
  approvalCalls = 0;
  rejectCalls = 0;
  topupResult = { payment: { status: 'pending_owner', id: 2, reason: 'Owner approval required' } };
  updateResponse = { ok: true, result: [] };
  webhookUrl = '';
  deleteWebhookBody = null;
  webhookDeleteFails = false;
  pollBodies = [];
  telegram.setTelegramEventHandler(async () => topupResult);
  installMockFetch();
});

test.afterEach(() => {
  telegram.stopTelegram();
  telegram.setTelegramEventHandler(null);
  global.fetch = originalFetch;
});

test('Telegram approves a pending request and reports Testnet evidence', async () => {
  assert.equal(await telegram.processUpdate(callback('approve:1')), true);
  assert.equal(transactions.get(1).status, 'owner_approved');
  assert.equal(approvalCalls, 1);
  assert.equal(callbackAnswers.length, 1);
  assert.match(sentMessages.join('\n'), /SUCCESS: Owner-approved XRPL Testnet payment/);
  assert.match(sentMessages.join('\n'), /TESTNET_HASH/);
});

test('failed approval reports failure and remains unacknowledged for retry', async () => {
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.includes('/answerCallbackQuery')) {
      callbackAnswers.push(body);
      return jsonResponse({ ok: true });
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(body.text);
      return jsonResponse({ ok: true });
    }
    if (url.includes('/tx/1')) return jsonResponse(tx(1));
    if (url.includes('/owner/approve/1')) return jsonResponse({ status: 'blocked', reason: 'Policy service unavailable' }, 503);
    throw new Error(`Unexpected mocked request: ${url}`);
  };

  assert.equal(await telegram.processUpdate(callback('approve:1', 70001, 2)), false);
  assert.match(sentMessages.join('\n'), /APPROVAL FAILED/);
});

test('Telegram rejection is applied once and returns a final message', async () => {
  assert.equal(await telegram.processUpdate(callback('reject:1', 70001, 3)), true);
  assert.equal(transactions.get(1).blocked_reason, 'rejected by owner');
  assert.equal(rejectCalls, 1);
  assert.match(sentMessages.join('\n'), /rejected by the owner/);
});

test('manual top-up returns the resulting pending status to the owner', async () => {
  assert.equal(await telegram.processUpdate(callback('topup:electricity', 70001, 4)), true);
  assert.match(sentMessages.join('\n'), /created and is awaiting owner approval/i);
});

test('manual top-up reports a policy block instead of success', async () => {
  topupResult = {
    payment: { status: 'blocked', id: 8, reason: 'policy service unavailable (fail-safe)' },
  };
  assert.equal(await telegram.processUpdate(callback('topup:data', 70001, 5)), false);
  assert.match(sentMessages.join('\n'), /was not paid/);
});

test('repeated approval tap is idempotent', async () => {
  assert.equal(await telegram.processUpdate(callback('approve:1', 70001, 6)), true);
  assert.equal(await telegram.processUpdate(callback('approve:1', 70001, 7)), true);
  assert.equal(approvalCalls, 1);
  assert.match(sentMessages.join('\n'), /already owner_approved/);
});

test('another Telegram user in the owner chat is rejected', async () => {
  assert.equal(await telegram.processUpdate(callback('approve:1', 70002, 8)), true);
  assert.equal(approvalCalls, 0);
  assert.match(String(callbackAnswers[0]?.text), /Unauthorized/);
});

test('polling conflict is visible in sanitized health status', async () => {
  updateResponse = { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' };
  await telegram.pollUpdatesOnce();
  assert.match(telegram.getTelegramStatus().lastError, /409|Conflict/);
});

test('policy-service outage returns an explicit unavailable result', async () => {
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.includes('/answerCallbackQuery')) {
      callbackAnswers.push(body);
      return jsonResponse({ ok: true });
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(body.text);
      return jsonResponse({ ok: true });
    }
    if (url.includes('/tx/1') || url.endsWith('/state')) throw new Error('connection refused');
    throw new Error(`Unexpected mocked request: ${url}`);
  };
  assert.equal(await telegram.processUpdate(callback('approve:1', 70001, 9)), false);
  assert.match(sentMessages.join('\n'), /Policy service is unavailable/);
});

test('polling removes a webhook without discarding queued updates', async () => {
  webhookUrl = 'https://example.invalid/gridbot-hook';
  telegram.initTelegram();
  for (let i = 0; i < 30 && !deleteWebhookBody; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(deleteWebhookBody, { drop_pending_updates: false });
  assert.equal(telegram.getTelegramStatus().polling, true);
});

test('webhook removal failure prevents polling', async () => {
  webhookDeleteFails = true;
  telegram.initTelegram();
  for (let i = 0; i < 30 && telegram.getTelegramStatus().polling; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(telegram.getTelegramStatus().polling, false);
  assert.equal(pollBodies.length, 0);
});

test('failed update handler does not advance polling offset', async () => {
  updateResponse = { ok: true, result: [callback('approve:1', 70001, 20)] };
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop();
      if (method === 'getUpdates') {
        pollBodies.push(body);
        return jsonResponse(updateResponse);
      }
      if (method === 'answerCallbackQuery') callbackAnswers.push(body);
      if (method === 'sendMessage') sentMessages.push(body.text);
      return jsonResponse({ ok: true, result: {} });
    }
    if (url.includes('/tx/1')) return jsonResponse(tx(1));
    if (url.includes('/owner/approve/1')) {
      return jsonResponse({ status: 'blocked', reason: 'Policy service unavailable' }, 503);
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  };
  await telegram.pollUpdatesOnce();
  assert.equal(pollBodies[0].offset, undefined);
  assert.match(sentMessages.join('\n'), /APPROVAL FAILED/);
});
