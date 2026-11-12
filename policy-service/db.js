// policy-service/db.js
// Off-chain persistence using Supabase (service role key, isolated inside policy-service),
// with automatic local fallback persistence if Supabase is temporarily unreachable (e.g. fetch failed).
//
// HONESTY NOTE:
// The XRP Ledger does NOT track the daily budget or spending caps.
// Budget logic lives here off-chain in the independent Policy Service, which refuses to co-sign
// over the cap. The ledger enforces the cryptographic multisig signature quorum.

const path = require('path');
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const LOCAL_STORE_PATH = path.join(__dirname, 'local-db-fallback.json');

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
      })
    : null;

let lastSupabaseWarnAt = 0;
function warnSupabaseFallback(context, err) {
  const now = Date.now();
  if (now - lastSupabaseWarnAt > 60000) {
    lastSupabaseWarnAt = now;
    console.warn(
      `[Policy DB] Supabase unreachable during ${context} (${err?.message || err}); using local fallback store.`
    );
  }
}

/**
 * Loads public addresses from ../wallets.public.json (or ./wallets.public.json if copied locally).
 */
function loadPublicWallets() {
  const candidates = [
    path.join(__dirname, '..', 'wallets.public.json'),
    path.join(__dirname, 'wallets.public.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  throw new Error('wallets.public.json not found');
}

function getDefaultStaff() {
  const ownerPass = (process.env.OWNER_PASSCODE || 'owner123').trim();
  const staffPass = (process.env.STAFF_PASSCODE || 'staff123').trim();
  return [
    {
      id: 1,
      username: 'thabo',
      displayName: 'Thabo (Shift Cashier)',
      passcode: staffPass,
      role: 'staff',
      active: true,
      shift: 'Day Shift (08:00 - 16:00)',
      created_at: new Date().toISOString(),
    },
    {
      id: 2,
      username: 'sipho',
      displayName: 'Sipho (Night Shift)',
      passcode: 'sipho123',
      role: 'staff',
      active: true,
      shift: 'Night Shift (16:00 - 00:00)',
      created_at: new Date().toISOString(),
    },
    {
      id: 3,
      username: 'owner',
      displayName: 'Cafe Owner (Admin)',
      passcode: ownerPass,
      role: 'owner',
      active: true,
      shift: 'Executive Administrator',
      created_at: new Date().toISOString(),
    },
  ];
}

function getDefaultPolicy() {
  const pubWallets = loadPublicWallets();
  const utilityAddress = pubWallets?.utility?.address;
  return {
    id: 1,
    daily_cap: 15,
    per_tx_cap: 10,
    allowed_payees: utilityAddress ? [utilityAddress] : [],
  };
}

function loadLocalStore() {
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, 'utf8'));
      const def = getDefaultPolicy();
      const policy = raw.policy || def;
      if (def.allowed_payees.length > 0 && !policy.allowed_payees?.includes(def.allowed_payees[0])) {
        policy.allowed_payees = def.allowed_payees;
      }
      return {
        policy: {
          id: 1,
          daily_cap: Number(policy.daily_cap ?? 15),
          per_tx_cap: Number(policy.per_tx_cap ?? 10),
          allowed_payees: parseAllowedPayees(policy.allowed_payees),
        },
        transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
        nextId: Number(raw.nextId) || 1,
        staff: Array.isArray(raw.staff) && raw.staff.length > 0 ? raw.staff : getDefaultStaff(),
        nextStaffId: Number(raw.nextStaffId) || 4,
      };
    }
  } catch {
    // ignore corrupt cache
  }
  return {
    policy: getDefaultPolicy(),
    transactions: [],
    nextId: 1,
    staff: getDefaultStaff(),
    nextStaffId: 4,
  };
}

function saveLocalStore(store) {
  try {
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // ignore write errors
  }
}

let localStore = loadLocalStore();

/**
 * Returns the ISO string for 00:00:00 today in Africa/Johannesburg (SAST, UTC+2).
 */
function getStartOfDayJohannesburgISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;

  const midnightSAST = new Date(`${year}-${month}-${day}T00:00:00+02:00`);
  return midnightSAST.toISOString();
}

function parseAllowedPayees(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Fetches policy row (id = 1). Seeds default policy if missing.
 * Falls back to local store if Supabase is unreachable.
 */
async function getPolicy() {
  const pubWallets = loadPublicWallets();
  const utilityAddress = pubWallets?.utility?.address;

  if (!supabase) {
    if (utilityAddress && !localStore.policy.allowed_payees.includes(utilityAddress)) {
      localStore.policy.allowed_payees = [utilityAddress];
      saveLocalStore(localStore);
    }
    return localStore.policy;
  }

  try {
    const { data, error } = await supabase
      .from('policy')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      const defaultPolicy = getDefaultPolicy();
      const { data: inserted, error: insertError } = await supabase
        .from('policy')
        .upsert(defaultPolicy, { onConflict: 'id' })
        .select()
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      const result = {
        ...inserted,
        daily_cap: Number(inserted.daily_cap),
        per_tx_cap: Number(inserted.per_tx_cap),
        allowed_payees: parseAllowedPayees(inserted.allowed_payees),
      };
      localStore.policy = result;
      saveLocalStore(localStore);
      return result;
    }

    const currentAllowlist = parseAllowedPayees(data.allowed_payees);

    if (utilityAddress && !currentAllowlist.includes(utilityAddress)) {
      const updatedAllowlist = [utilityAddress];
      const { data: synced, error: syncErr } = await supabase
        .from('policy')
        .update({ allowed_payees: updatedAllowlist })
        .eq('id', 1)
        .select()
        .single();

      if (!syncErr && synced) {
        const result = {
          ...synced,
          daily_cap: Number(synced.daily_cap),
          per_tx_cap: Number(synced.per_tx_cap),
          allowed_payees: parseAllowedPayees(synced.allowed_payees),
        };
        localStore.policy = result;
        saveLocalStore(localStore);
        return result;
      }
    }

    const result = {
      ...data,
      daily_cap: Number(data.daily_cap),
      per_tx_cap: Number(data.per_tx_cap),
      allowed_payees: currentAllowlist,
    };
    localStore.policy = result;
    saveLocalStore(localStore);
    return result;
  } catch (err) {
    warnSupabaseFallback('getPolicy', err);
    if (utilityAddress && !localStore.policy.allowed_payees.includes(utilityAddress)) {
      localStore.policy.allowed_payees = [utilityAddress];
      saveLocalStore(localStore);
    }
    return localStore.policy;
  }
}

/**
 * Updates policy settings in Supabase and local store.
 */
async function updatePolicy(fields) {
  await getPolicy();
  const updatePayload = {};
  if (fields.daily_cap !== undefined) updatePayload.daily_cap = Number(fields.daily_cap);
  if (fields.per_tx_cap !== undefined) updatePayload.per_tx_cap = Number(fields.per_tx_cap);
  if (fields.allowed_payees !== undefined) updatePayload.allowed_payees = fields.allowed_payees;

  localStore.policy = {
    ...localStore.policy,
    ...updatePayload,
    daily_cap: Number(updatePayload.daily_cap ?? localStore.policy.daily_cap),
    per_tx_cap: Number(updatePayload.per_tx_cap ?? localStore.policy.per_tx_cap),
    allowed_payees: parseAllowedPayees(
      updatePayload.allowed_payees ?? localStore.policy.allowed_payees
    ),
  };
  saveLocalStore(localStore);

  if (!supabase) return localStore.policy;

  try {
    const { data, error } = await supabase
      .from('policy')
      .update(updatePayload)
      .eq('id', 1)
      .select()
      .single();

    if (error) throw new Error(error.message);

    const synced = {
      ...data,
      daily_cap: Number(data.daily_cap),
      per_tx_cap: Number(data.per_tx_cap),
      allowed_payees: parseAllowedPayees(data.allowed_payees),
    };
    localStore.policy = synced;
    saveLocalStore(localStore);
    return synced;
  } catch (err) {
    warnSupabaseFallback('updatePolicy', err);
    return localStore.policy;
  }
}

/**
 * Sums `amount` for rows with status 'auto_approved' or 'owner_approved'
 * since midnight Africa/Johannesburg time.
 */
async function spentToday() {
  const startOfDayISO = getStartOfDayJohannesburgISO();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('amount, ts, status')
        .in('status', ['auto_approved', 'owner_approved'])
        .gte('ts', startOfDayISO);

      if (error) throw new Error(error.message);

      const total = (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      return Math.round(total * 1e6) / 1e6;
    } catch (err) {
      warnSupabaseFallback('spentToday', err);
    }
  }

  const total = localStore.transactions
    .filter(
      (row) =>
        (row.status === 'auto_approved' || row.status === 'owner_approved') &&
        row.ts >= startOfDayISO
    )
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Checks if an identical pending_owner row (same resource + amount) exists from the last 60 seconds.
 */
async function findRecentPendingDuplicate(resource, amount, withinSeconds = 60) {
  const cutoffISO = new Date(Date.now() - withinSeconds * 1000).toISOString();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('status', 'pending_owner')
        .eq('resource', resource)
        .eq('amount', Number(amount))
        .gte('ts', cutoffISO)
        .order('ts', { ascending: false })
        .order('id', { ascending: false })
        .limit(1);

      if (error) throw new Error(error.message);

      if (data && data.length > 0) {
        return {
          ...data[0],
          amount: Number(data[0].amount),
        };
      }
      return null;
    } catch (err) {
      warnSupabaseFallback('findRecentPendingDuplicate', err);
    }
  }

  const found = localStore.transactions.find(
    (tx) =>
      tx.status === 'pending_owner' &&
      tx.resource === resource &&
      Number(tx.amount) === Number(amount) &&
      tx.ts >= cutoffISO
  );
  return found ? { ...found, amount: Number(found.amount) } : null;
}

/**
 * Checks if a velocity-limit blocked row already exists within the current window (e.g. last 60s).
 */
async function findRecentVelocityBlocked(withinSeconds = 60) {
  const cutoffISO = new Date(Date.now() - withinSeconds * 1000).toISOString();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('status', 'blocked')
        .eq('blocked_reason', 'velocity limit')
        .gte('ts', cutoffISO)
        .order('ts', { ascending: false })
        .order('id', { ascending: false })
        .limit(1);

      if (error) throw new Error(error.message);

      if (data && data.length > 0) {
        return {
          ...data[0],
          amount: Number(data[0].amount),
        };
      }
      return null;
    } catch (err) {
      warnSupabaseFallback('findRecentVelocityBlocked', err);
    }
  }

  const found = localStore.transactions.find(
    (tx) =>
      tx.status === 'blocked' &&
      tx.blocked_reason === 'velocity limit' &&
      tx.ts >= cutoffISO
  );
  return found ? { ...found, amount: Number(found.amount) } : null;
}

/**
 * Inserts a new transaction row and returns the inserted row.
 */
async function logTx({
  resource,
  amount,
  payee,
  reason,
  status,
  tx_hash = null,
  blocked_reason = null,
}) {
  const payload = {
    ts: new Date().toISOString(),
    resource,
    amount: Number(amount),
    payee,
    reason,
    status,
    tx_hash,
    blocked_reason,
  };

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);

      const row = {
        ...data,
        amount: Number(data.amount),
      };
      localStore.transactions.unshift(row);
      localStore.transactions = localStore.transactions.slice(0, 100);
      saveLocalStore(localStore);
      return row;
    } catch (err) {
      warnSupabaseFallback('logTx', err);
    }
  }

  const localRow = {
    id: localStore.nextId++,
    ...payload,
  };
  localStore.transactions.unshift(localRow);
  localStore.transactions = localStore.transactions.slice(0, 100);
  saveLocalStore(localStore);
  return localRow;
}

/**
 * Updates an existing transaction row by id and returns the updated row.
 */
async function updateTx(id, fields) {
  const idx = localStore.transactions.findIndex((tx) => String(tx.id) === String(id));
  if (idx !== -1) {
    localStore.transactions[idx] = {
      ...localStore.transactions[idx],
      ...fields,
      amount: Number(fields.amount ?? localStore.transactions[idx].amount),
    };
    saveLocalStore(localStore);
  }

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .update(fields)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);

      return {
        ...data,
        amount: Number(data.amount),
      };
    } catch (err) {
      warnSupabaseFallback('updateTx', err);
    }
  }

  if (idx !== -1) {
    return localStore.transactions[idx];
  }
  throw new Error(`Transaction #${id} not found`);
}

/**
 * Fetches a single transaction row by id.
 */
async function getTx(id) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) throw new Error(error ? error.message : 'Not found');

      return {
        ...data,
        amount: Number(data.amount),
      };
    } catch (err) {
      warnSupabaseFallback('getTx', err);
    }
  }

  const found = localStore.transactions.find((tx) => String(tx.id) === String(id));
  if (!found) {
    throw new Error(`Transaction #${id} not found`);
  }
  return {
    ...found,
    amount: Number(found.amount),
  };
}

/**
 * Lists transactions ordered by newest first (ts DESC, id DESC).
 */
async function listTx(limit = 50) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .order('ts', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);

      const rows = (data || []).map((row) => ({
        ...row,
        amount: Number(row.amount),
      }));
      if (rows.length > 0) {
        localStore.transactions = rows;
        saveLocalStore(localStore);
      }
      return rows;
    } catch (err) {
      warnSupabaseFallback('listTx', err);
    }
  }

  return localStore.transactions.slice(0, limit).map((row) => ({
    ...row,
    amount: Number(row.amount),
  }));
}

/**
 * ============================================================================
 * Staff Management (Supabase with Local Fallback)
 * ============================================================================
 */

/**
 * Lists staff users. Excludes passcodes from public view unless requested.
 */
async function listStaffUsers() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('staff_users')
        .select('*')
        .order('id', { ascending: true });

      if (!error && Array.isArray(data) && data.length > 0) {
        localStore.staff = data;
        saveLocalStore(localStore);
        return data.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName || u.display_name,
          role: u.role || 'staff',
          active: u.active !== false,
          shift: u.shift || 'Flexible Shift',
          created_at: u.created_at || u.createdAt,
        }));
      }
    } catch (err) {
      warnSupabaseFallback('listStaffUsers', err);
    }
  }

  return (localStore.staff || []).map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role || 'staff',
    active: u.active !== false,
    shift: u.shift || 'Flexible Shift',
    created_at: u.created_at,
  }));
}

/**
 * Creates a new staff member.
 */
async function createStaffUser({ username, displayName, passcode, role = 'staff', shift = 'Flexible Shift' }) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanDisplayName = String(displayName || '').trim();
  const cleanPasscode = String(passcode || '').trim();

  if (!cleanUsername || !cleanDisplayName || !cleanPasscode) {
    throw new Error('Username, Full Name, and Passcode are required.');
  }

  const existing = (localStore.staff || []).find((s) => s.username === cleanUsername);
  if (existing) {
    throw new Error(`Username "${cleanUsername}" is already taken.`);
  }

  const newStaff = {
    id: localStore.nextStaffId++,
    username: cleanUsername,
    displayName: cleanDisplayName,
    passcode: cleanPasscode,
    role: role === 'owner' ? 'owner' : 'staff',
    active: true,
    shift: shift || 'Flexible Shift',
    created_at: new Date().toISOString(),
  };

  localStore.staff.push(newStaff);
  saveLocalStore(localStore);

  if (supabase) {
    try {
      await supabase.from('staff_users').insert({
        username: newStaff.username,
        display_name: newStaff.displayName,
        passcode: newStaff.passcode,
        role: newStaff.role,
        active: newStaff.active,
        shift: newStaff.shift,
        created_at: newStaff.created_at,
      });
    } catch (err) {
      warnSupabaseFallback('createStaffUser', err);
    }
  }

  return {
    id: newStaff.id,
    username: newStaff.username,
    displayName: newStaff.displayName,
    role: newStaff.role,
    active: newStaff.active,
    shift: newStaff.shift,
    created_at: newStaff.created_at,
  };
}

/**
 * Deletes or deactivates a staff member.
 */
async function deleteStaffUser(id) {
  const staffId = Number(id);
  const target = (localStore.staff || []).find((s) => s.id === staffId);
  if (!target) {
    throw new Error(`Staff user #${id} not found.`);
  }
  if (target.username === 'owner') {
    throw new Error('Cannot delete primary cafe owner account.');
  }

  localStore.staff = localStore.staff.filter((s) => s.id !== staffId);
  saveLocalStore(localStore);

  if (supabase) {
    try {
      await supabase.from('staff_users').delete().eq('id', staffId);
    } catch (err) {
      warnSupabaseFallback('deleteStaffUser', err);
    }
  }

  return { ok: true, deletedId: staffId };
}

/**
 * Verifies staff or owner credentials.
 */
async function verifyStaffUser(username, passcode) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanPasscode = String(passcode || '').trim();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('staff_users')
        .select('*')
        .eq('username', cleanUsername)
        .eq('passcode', cleanPasscode)
        .maybeSingle();

      if (!error && data) {
        return {
          ok: true,
          user: {
            username: data.username,
            displayName: data.displayName || data.display_name,
            role: data.role || 'staff',
            shift: data.shift || 'Flexible Shift',
          },
        };
      }
    } catch (err) {
      warnSupabaseFallback('verifyStaffUser', err);
    }
  }

  const found = (localStore.staff || []).find(
    (s) => s.username === cleanUsername && s.passcode === cleanPasscode && s.active !== false
  );

  if (found) {
    return {
      ok: true,
      user: {
        username: found.username,
        displayName: found.displayName,
        role: found.role || 'staff',
        shift: found.shift || 'Flexible Shift',
      },
    };
  }

  return { ok: false, error: 'Invalid username or passcode' };
}

module.exports = {
  supabase,
  loadPublicWallets,
  getPolicy,
  updatePolicy,
  spentToday,
  findRecentPendingDuplicate,
  findRecentVelocityBlocked,
  logTx,
  updateTx,
  getTx,
  listTx,
  listStaffUsers,
  createStaffUser,
  deleteStaffUser,
  verifyStaffUser,
};
