const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://auth-test.invalid';
process.env.SUPABASE_SERVICE_KEY = 'auth-test-key';

const users = [
  {
    username: 'staff',
    passcode: 'staff123',
    role: 'staff',
    display_name: 'Test Staff',
    active: true,
  },
  {
    username: 'owner',
    passcode: 'owner123',
    role: 'owner',
    display_name: 'Test Owner',
    active: true,
  },
];

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        from(table) {
          assert.equal(table, 'staff_users');
          const filters = {};
          return {
            select() {
              return this;
            },
            eq(field, value) {
              filters[field] = value;
              return this;
            },
            async maybeSingle() {
              return {
                data: users.find((user) =>
                  Object.entries(filters).every(([field, value]) => user[field] === value)
                ) || null,
                error: null,
              };
            },
          };
        },
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const dbPath = require.resolve('./policy-service/db');
const db = require('./policy-service/db');
Module._load = originalLoad;

process.env.OWNER_PASSCODE = 'owner123';
const originalAuthLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './policy-client') {
    return {
      verifyStaffCredentials: async (username, password) =>
        username === 'owner' && password === process.env.OWNER_PASSCODE
          ? {
              ok: true,
              user: { username: 'owner', displayName: 'Test Owner', role: 'owner' },
            }
          : { ok: false },
    };
  }
  return originalAuthLoad.call(this, request, parent, isMain);
};
const authPath = require.resolve('./auth');
const auth = require('./auth');
Module._load = originalAuthLoad;

test('accepts configured starter passcodes only when an exact Supabase account matches', async () => {
  const staff = await db.verifyStaffUser('staff', 'staff123');
  assert.equal(staff.ok, true);
  assert.equal(staff.user.role, 'staff');

  const owner = await db.verifyStaffUser('owner', 'owner123');
  assert.equal(owner.ok, true);
  assert.equal(owner.user.role, 'owner');

  const localFallback = await db.verifyStaffUser('thabo', 'sipho123');
  assert.equal(localFallback.ok, false);
  assert.match(localFallback.error, /local fallback/i);
});

test('allows an owner session to use its configured passcode for owner actions', async () => {
  const login = await auth.login({ username: 'owner', password: process.env.OWNER_PASSCODE });
  assert.equal(login.ok, true);

  const req = { headers: { 'x-session-token': login.token } };
  let continued = false;
  auth.requireOwner(req, { status() { return this; }, json() {} }, () => {
    continued = true;
  });

  assert.equal(continued, true);
  assert.equal(req.ownerPasscode, process.env.OWNER_PASSCODE);
});

test.after(() => {
  delete require.cache[dbPath];
  delete require.cache[authPath];
});
