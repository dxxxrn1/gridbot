// resources.js
// Mocked prepaid resource plugins + vending APIs for GridBot demos.
// (MOCKED: Meter/router simulator, Eskom/municipal 20-digit STS electricity token vending API,
// and mobile LTE data bundle vending API.)

const crypto = require("crypto");

/**
 * Generates a random 20-digit Standard Transfer Specification (STS) prepaid electricity token
 * formatted as: XXXX XXXX XXXX XXXX XXXX
 */
function generateStsToken() {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    let group = "";
    for (let d = 0; d < 4; d++) {
      group += crypto.randomInt(0, 10).toString();
    }
    groups.push(group);
  }
  return groups.join(" ");
}

/**
 * Picks a descriptive LTE data bundle name based on the RLUSD amount spent.
 */
function pickDataBundleName(amount) {
  const num = Number(amount) || 3;
  if (num >= 10) return "25GB Business LTE Peak Bundle";
  if (num >= 5) return "10GB LTE Cafe Booster Bundle";
  return "5GB LTE bundle";
}

function clampLevel(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num * 10) / 10));
}

// Internal simulated levels (0 - 100%)
const state = {
  electricity: 100,
  data: 100,
};

const electricity = {
  id: "electricity",
  label: "Prepaid Electricity Meter (Mock)",
  priority: 1,
  threshold: 5, // 5% low-balance threshold
  unitCostRLUSD: 5, // Default/reference top-up cost in RLUSD
  isMock: true,

  getLevel() {
    return state.electricity;
  },

  setLevel(val) {
    state.electricity = clampLevel(val);
    return state.electricity;
  },

  drain(amount) {
    // Default drain per 2s tick: ~1.5% - 3.0% so levels visibly move during a live demo
    const drop =
      amount !== undefined ? Number(amount) : 1.5 + Math.random() * 1.5;
    state.electricity = clampLevel(state.electricity - drop);
    return state.electricity;
  },

  vend(amount) {
    const token = generateStsToken();
    const kwhAdded = Math.max(
      10,
      Math.round((Number(amount) || this.unitCostRLUSD) * 12),
    );
    state.electricity = 100;
    return {
      ok: true,
      token,
      kwhAdded,
      level: state.electricity,
      mockProvider: "SA Prepaid STS Vending Mock",
    };
  },
};

const data = {
  id: "data",
  label: "Router LTE Data Cap (Mock)",
  priority: 2,
  threshold: 10, // 10% low-balance threshold
  unitCostRLUSD: 3, // Default/reference top-up cost in RLUSD
  isMock: true,

  getLevel() {
    return state.data;
  },

  setLevel(val) {
    state.data = clampLevel(val);
    return state.data;
  },

  drain(amount) {
    // Default drain per 2s tick: ~2.0% - 3.5%
    const drop =
      amount !== undefined ? Number(amount) : 2.0 + Math.random() * 1.5;
    state.data = clampLevel(state.data - drop);
    return state.data;
  },

  vend(amount) {
    const bundle = pickDataBundleName(amount);
    state.data = 100;
    return {
      ok: true,
      bundle,
      level: state.data,
      mockProvider: "SA Telco LTE Vending Mock",
    };
  },
};

const resources = {
  electricity,
  data,
};

/**
 * Returns all resource plugins sorted by priority ascending (1 = highest priority).
 */
function listResources() {
  return Object.values(resources).sort((a, b) => a.priority - b.priority);
}

/**
 * Gets a resource plugin by id ('electricity' | 'data').
 */
function getResource(id) {
  const res = resources[id];
  if (!res) {
    throw new Error(`Unknown resource id: ${id}`);
  }
  return res;
}

/**
 * Force-sets the level (0 - 100) of a resource by id (for demo buttons / testing).
 */
function setLevel(id, val) {
  const res = getResource(id);
  return res.setLevel(val);
}

module.exports = {
  resources,
  electricity,
  data,
  listResources,
  getResource,
  setLevel,
};
