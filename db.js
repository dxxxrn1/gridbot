// db.js
// Off-chain persistence using Supabase (service role key, backend only).
// NOTE: The XRP Ledger does NOT track the daily budget or spending caps.
// Budget tracking and policy state live here off-chain and are checked by the
// off-chain Policy Signer service before co-signing any transaction.
// The ledger enforces only that no payment executes without the required multisig quorum.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const { ensureLocalWalletsFile } = require("./setup-wallets");

function loadWallets() {
  return ensureLocalWalletsFile();
}

/**
 * Returns the ISO string for 00:00:00 today in Africa/Johannesburg (SAST, UTC+2).
 * South Africa does not observe daylight saving time (fixed UTC+02:00).
 */
function getStartOfDayJohannesburgISO() {
  const now = new Date();
  // Format current date parts in Africa/Johannesburg timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;

  // Midnight SAST is +02:00
  const midnightSAST = new Date(`${year}-${month}-${day}T00:00:00+02:00`);
  return midnightSAST.toISOString();
}

/**
 * Normalizes allowed_payees whether stored as a JSONB array or a JSON string.
 */
function parseAllowedPayees(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

/**
 * Fetches policy row (id = 1). Seeds default policy if missing.
 * Defaults: daily_cap = 15, per_tx_cap = 10, allowed_payees = [wallets.utility.address]
 */
async function getPolicy() {
  const { data, error } = await supabase
    .from("policy")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase getPolicy error: ${error.message}`);
  }

  if (!data) {
    const wallets = loadWallets();
    const utilityAddress = wallets?.utility?.address;
    if (!utilityAddress) {
      throw new Error(
        "Cannot seed default policy: utility.address missing in wallets.json",
      );
    }

    const defaultPolicy = {
      id: 1,
      daily_cap: 15,
      per_tx_cap: 10,
      allowed_payees: [utilityAddress],
    };

    const { data: inserted, error: insertError } = await supabase
      .from("policy")
      .upsert(defaultPolicy, { onConflict: "id" })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Supabase seed policy error: ${insertError.message}`);
    }

    return {
      ...inserted,
      daily_cap: Number(inserted.daily_cap),
      per_tx_cap: Number(inserted.per_tx_cap),
      allowed_payees: parseAllowedPayees(inserted.allowed_payees),
    };
  }

  const wallets = loadWallets();
  const utilityAddress = wallets?.utility?.address;
  const currentAllowlist = parseAllowedPayees(data.allowed_payees);

  // Auto-sync allowed_payees if setup.js generated a new utility wallet address
  if (utilityAddress && !currentAllowlist.includes(utilityAddress)) {
    const updatedAllowlist = [utilityAddress];
    const { data: synced, error: syncErr } = await supabase
      .from("policy")
      .update({ allowed_payees: updatedAllowlist })
      .eq("id", 1)
      .select()
      .single();

    if (!syncErr && synced) {
      return {
        ...synced,
        daily_cap: Number(synced.daily_cap),
        per_tx_cap: Number(synced.per_tx_cap),
        allowed_payees: parseAllowedPayees(synced.allowed_payees),
      };
    }
  }

  return {
    ...data,
    daily_cap: Number(data.daily_cap),
    per_tx_cap: Number(data.per_tx_cap),
    allowed_payees: currentAllowlist,
  };
}

/**
 * Updates policy settings in Supabase (for dashboard / owner config updates).
 */
async function updatePolicy(fields) {
  await getPolicy(); // ensure seeded
  const updatePayload = {};
  if (fields.daily_cap !== undefined)
    updatePayload.daily_cap = Number(fields.daily_cap);
  if (fields.per_tx_cap !== undefined)
    updatePayload.per_tx_cap = Number(fields.per_tx_cap);
  if (fields.allowed_payees !== undefined)
    updatePayload.allowed_payees = fields.allowed_payees;

  const { data, error } = await supabase
    .from("policy")
    .update(updatePayload)
    .eq("id", 1)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase updatePolicy error: ${error.message}`);
  }

  const wallets = loadWallets();
  const utilityAddress = wallets?.utility?.address;
  const currentAllowlist = parseAllowedPayees(data.allowed_payees);

  // Auto-sync allowed_payees if setup.js generated a new utility wallet address
  if (utilityAddress && !currentAllowlist.includes(utilityAddress)) {
    const updatedAllowlist = [utilityAddress];
    const { data: synced, error: syncErr } = await supabase
      .from("policy")
      .update({ allowed_payees: updatedAllowlist })
      .eq("id", 1)
      .select()
      .single();

    if (!syncErr && synced) {
      return {
        ...synced,
        daily_cap: Number(synced.daily_cap),
        per_tx_cap: Number(synced.per_tx_cap),
        allowed_payees: parseAllowedPayees(synced.allowed_payees),
      };
    }
  }

  return {
    ...data,
    daily_cap: Number(data.daily_cap),
    per_tx_cap: Number(data.per_tx_cap),
    allowed_payees: currentAllowlist,
  };
}

/**
 * Sums `amount` for rows with status 'auto_approved' or 'owner_approved'
 * since midnight Africa/Johannesburg time.
 */
async function spentToday() {
  const startOfDayISO = getStartOfDayJohannesburgISO();

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, ts, status")
    .in("status", ["auto_approved", "owner_approved"])
    .gte("ts", startOfDayISO);

  if (error) {
    throw new Error(`Supabase spentToday error: ${error.message}`);
  }

  const total = (data || []).reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );
  return Math.round(total * 1e6) / 1e6;
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

  const { data, error } = await supabase
    .from("transactions")
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase logTx error: ${error.message}`);
  }

  return {
    ...data,
    amount: Number(data.amount),
  };
}

/**
 * Updates an existing transaction row by id and returns the updated row.
 */
async function updateTx(id, fields) {
  const { data, error } = await supabase
    .from("transactions")
    .update(fields)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase updateTx error: ${error.message}`);
  }

  return {
    ...data,
    amount: Number(data.amount),
  };
}

/**
 * Fetches a single transaction row by id. Throws if DB error or if row does not exist.
 */
async function getTx(id) {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    throw new Error(
      `Supabase getTx error for id ${id}: ${error ? error.message : "Not found"}`,
    );
  }

  return {
    ...data,
    amount: Number(data.amount),
  };
}

/**
 * Lists transactions ordered by newest first (ts DESC, id DESC).
 */
async function listTx(limit = 50) {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .order("ts", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Supabase listTx error: ${error.message}`);
  }

  return (data || []).map((row) => ({
    ...row,
    amount: Number(row.amount),
  }));
}

module.exports = {
  supabase,
  getPolicy,
  updatePolicy,
  spentToday,
  logTx,
  updateTx,
  getTx,
  listTx,
};
