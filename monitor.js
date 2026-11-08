// monitor.js
// Background resource monitor that ticks every 2 seconds, drains simulated
// resources, and emits 'level' (every tick) and 'low' (once per low episode
// when a resource drops at or below its threshold until refilled above threshold).

const EventEmitter = require('events');
const { listResources, getResource } = require('./resources');

const TICK_MS = 2000;
const emitter = new EventEmitter();

let timer = null;
// Tracks which resources have already fired 'low' during the current low-balance episode
const lowFired = new Set();

/**
 * Checks all resources' current levels against their thresholds.
 * Resets the lowFired latch when a resource is refilled above threshold,
 * and emits 'low' once when a resource is below (or at) threshold.
 */
function evaluateLevels(snapshot) {
  for (const item of snapshot) {
    const plugin = getResource(item.id);
    if (item.level > item.threshold) {
      // Resource has been refilled above threshold -> reset latch
      lowFired.delete(item.id);
    } else if (item.level <= item.threshold && !lowFired.has(item.id)) {
      // Dropped to/below threshold for the first time since full -> fire 'low' once
      lowFired.add(item.id);
      emitter.emit('low', {
        id: plugin.id,
        label: plugin.label,
        level: item.level,
        threshold: plugin.threshold,
        priority: plugin.priority,
        unitCostRLUSD: plugin.unitCostRLUSD,
        resource: plugin,
        ts: new Date().toISOString(),
      });
    }
  }
}

/**
 * Builds a clean snapshot array of all resource states.
 */
function getSnapshot() {
  return listResources().map((r) => ({
    id: r.id,
    label: r.label,
    level: r.getLevel(),
    threshold: r.threshold,
    priority: r.priority,
    unitCostRLUSD: r.unitCostRLUSD,
    isMock: true,
  }));
}

/**
 * Single 2-second monitor tick: drains each resource a little, emits 'level',
 * and emits 'low' if any resource crossed below its threshold.
 */
function tick() {
  const plugins = listResources();
  for (const r of plugins) {
    r.drain();
  }

  const snapshot = getSnapshot();
  emitter.emit('level', snapshot);
  evaluateLevels(snapshot);
}

/**
 * Starts the 2-second resource monitoring loop.
 */
function start(intervalMs = TICK_MS) {
  if (timer) return emitter;
  // Sync initial latch state before first tick
  for (const r of listResources()) {
    if (r.getLevel() > r.threshold) {
      lowFired.delete(r.id);
    }
  }
  timer = setInterval(tick, intervalMs);
  return emitter;
}

/**
 * Stops the monitoring loop.
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Manually triggers a level check (e.g., right after force-setting a level in the UI).
 */
function checkNow() {
  const snapshot = getSnapshot();
  emitter.emit('level', snapshot);
  evaluateLevels(snapshot);
  return snapshot;
}

module.exports = {
  emitter,
  start,
  stop,
  tick,
  checkNow,
  getSnapshot,
};
