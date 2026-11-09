// resources.js
// Mocked prepaid resource plugins + vending APIs for GridBot demos.
// (MOCKED: Meter/router simulator, Eskom/municipal 20-digit STS electricity token vending API,
// and mobile LTE data bundle vending API.)

const crypto = require('crypto');

/**
 * Generates a random 20-digit Standard Transfer Specification (STS) prepaid electricity token
 * formatted as: XXXX XXXX XXXX XXXX XXXX
 */
function generateStsToken() {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    let group = '';
    for (let d = 0; d < 4; d++) {
      group += crypto.randomInt(0, 10).toString();
    }
    groups.push(group);
  }
  return groups.join(' ');
}

/**
 * Builds a descriptive LTE data bundle name whose size scales with the RLUSD amount spent.
 */
function pickDataBundleName(amount) {
  const num = Math.max(0.5, Number(amount) || 3);
  const gb = Math.max(1, Math.round(num * (5 / 3) * 10) / 10);
  return `${gb}GB LTE bundle`;
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
  id: 'electricity',
  label: 'Prepaid Electricity Meter (Mock)',
  priority: 1,
  threshold: 5, // 5% low-balance threshold
  unitCostRLUSD: 5,
  percentPerRLUSD: 20, // 1 RLUSD adds 20% (5 RLUSD refills 100%)
  isMock: true,

  getLevel() {
    return state.electricity;
  },

  setLevel(val) {
    state.electricity = clampLevel(val);
    return state.electricity;
  },

  drain(amount) {
    const drop = amount !== undefined ? Number(amount) : 1.5 + Math.random() * 1.5;
    state.electricity = clampLevel(state.electricity - drop);
    return state.electricity;
  },

  vend(amount) {
    const numAmount = Math.max(0, Number(amount) || this.unitCostRLUSD);
    const before = state.electricity;
    const rawAdded = numAmount * this.percentPerRLUSD;
    state.electricity = clampLevel(before + rawAdded);
    const added = Math.round((state.electricity - before) * 10) / 10;

    const token = generateStsToken();
    const kwhAdded = Math.max(1, Math.round(numAmount * 12 * 10) / 10);

    return {
      ok: true,
      added,
      level: state.electricity,
      token,
      kwhAdded,
      mockProvider: 'SA Prepaid STS Vending Mock',
    };
  },
};

const data = {
  id: 'data',
  label: 'Router LTE Data Cap (Mock)',
  priority: 2,
  threshold: 10, // 10% low-balance threshold
  unitCostRLUSD: 3,
  percentPerRLUSD: 33.3, // 1 RLUSD adds 33.3% (~3 RLUSD refills ~100%)
  isMock: true,

  getLevel() {
    return state.data;
  },

  setLevel(val) {
    state.data = clampLevel(val);
    return state.data;
  },

  drain(amount) {
    const drop = amount !== undefined ? Number(amount) : 2.0 + Math.random() * 1.5;
    state.data = clampLevel(state.data - drop);
    return state.data;
  },

  vend(amount) {
    const numAmount = Math.max(0, Number(amount) || this.unitCostRLUSD);
    const before = state.data;
    const rawAdded = numAmount * this.percentPerRLUSD;
    state.data = clampLevel(before + rawAdded);
    const added = Math.round((state.data - before) * 10) / 10;

    const bundle = pickDataBundleName(numAmount);
    const gbAdded = Math.max(1, Math.round(numAmount * (5 / 3) * 10) / 10);

    return {
      ok: true,
      added,
      level: state.data,
      bundle,
      gbAdded,
      mockProvider: 'SA Telco LTE Vending Mock',
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
