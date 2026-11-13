// monitor.js
// Background resource monitor that checks simulated resources every 2 seconds
// and emits 'level' (every tick) and 'low' (when a resource drops
// at or below its threshold, retrying at most once every 60 seconds if it
// remains at or below threshold until refilled).

const EventEmitter = require('events');
const { listResources, getResource } = require('./resources');

const TICK_MS = 2000;
const LOW_RETRY_MS = 60000; // Re-emit 'low' at most once every 60s while still <= threshold
const WARN_LEVEL_PERCENT = 20; // Proactive early warning threshold (20%)
const emitter = new EventEmitter();

let timer = null;
// Map of resourceId -> timestamp (ms) of the last emitted 'low' event
const lastLowFiredAt = new Map();
// Set of resourceIds that have already fired the 20% early warning in the current low-level episode
const warnFiredSet = new Set();

/**
 * Resets the low-event latch/timers for all resources (or a single resource id).
 */
function resetLatch(resourceId) {
  if (resourceId) {
    lastLowFiredAt.delete(resourceId);
    warnFiredSet.delete(resourceId);
  } else {
    lastLowFiredAt.clear();
    warnFiredSet.clear();
  }
}

/**
 * Delays the next automatic 'low' retry for a resource (e.g. when waiting on owner approval)
 * so repeated low ticks do not spam the Policy Service or trip its 6/min velocity limit.
 */
function setCooldown(resourceId, cooldownMs = 120000) {
  if (!resourceId) return;
  const delay = Math.max(0, Number(cooldownMs) || 0);
  lastLowFiredAt.set(resourceId, Date.now() - LOW_RETRY_MS + delay);
}

/**
 * Checks all resources' current levels against the 20% early-warning threshold and critical thresholds.
 * - If level > 20%: clears the 20% warning latch for that resource.
 * - If threshold < level <= 20%: emits 'warning' once per low-level episode.
 * - If level > threshold: clears the critical 'low' latch for that resource.
 * - If level <= threshold: emits 'low' immediately if not yet fired, or retries if >= 60s
 *   have elapsed since the last 'low' emission for that resource.
 */
function evaluateLevels(snapshot) {
  const now = Date.now();

  for (const item of snapshot) {
    const plugin = getResource(item.id);

    if (item.level > WARN_LEVEL_PERCENT) {
      warnFiredSet.delete(item.id);
    } else if (item.level > item.threshold && !warnFiredSet.has(item.id)) {
      warnFiredSet.add(item.id);
      emitter.emit('warning', {
        id: plugin.id,
        label: plugin.label,
        level: Math.round(item.level),
        warnThreshold: WARN_LEVEL_PERCENT,
        criticalThreshold: plugin.threshold,
        unitCostRLUSD: plugin.unitCostRLUSD,
        percentPerRLUSD: plugin.percentPerRLUSD,
        ts: new Date(now).toISOString(),
      });
    }

    if (item.level > item.threshold) {
      // Resource has been refilled above threshold -> reset latch
      lastLowFiredAt.delete(item.id);
    } else {
      const lastTs = lastLowFiredAt.get(item.id);
      if (lastTs === undefined || now - lastTs >= LOW_RETRY_MS) {
        lastLowFiredAt.set(item.id, now);
        emitter.emit('low', {
          id: plugin.id,
          label: plugin.label,
          level: item.level,
          threshold: plugin.threshold,
          priority: plugin.priority,
          unitCostRLUSD: plugin.unitCostRLUSD,
          percentPerRLUSD: plugin.percentPerRLUSD,
          resource: plugin,
          ts: new Date(now).toISOString(),
        });
      }
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
    capacityKwh: r.capacityKwh,
    capacityGb: r.capacityGb,
    percentPerRLUSD: r.percentPerRLUSD,
    isMock: true,
  }));
}

/**
 * Single monitor tick: publishes current levels without changing them, and
 * emits 'low' if any resource is at or below its threshold.
 */
function tick() {
  const snapshot = getSnapshot();
  emitter.emit('level', snapshot);
  evaluateLevels(snapshot);
}

/**
 * Starts the 2-second resource monitoring loop.
 */
function start(intervalMs = TICK_MS) {
  if (timer) return emitter;
  for (const r of listResources()) {
    if (r.getLevel() > r.threshold) {
      lastLowFiredAt.delete(r.id);
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
  resetLatch,
  setCooldown,
  getSnapshot,
};
