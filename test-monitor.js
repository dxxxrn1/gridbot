const assert = require('node:assert/strict');
const test = require('node:test');

const { electricity, data, setLevel } = require('./resources');
const monitor = require('./monitor');

function resetResources() {
  setLevel('electricity', 100);
  setLevel('data', 100);
  monitor.resetLatch();
}

test('monitor ticks drain simulated meters and report levels', (t) => {
  resetResources();
  const snapshots = [];
  const onLevel = (levels) => snapshots.push(levels);
  monitor.emitter.on('level', onLevel);
  t.after(() => {
    monitor.emitter.off('level', onLevel);
    resetResources();
  });

  monitor.tick();

  assert.ok(electricity.getLevel() < 100 && electricity.getLevel() > 95);
  assert.ok(data.getLevel() < 100 && data.getLevel() > 95);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].find((item) => item.id === 'electricity').capacityKwh, 60);
  assert.equal(snapshots[0].find((item) => item.id === 'data').capacityGb, 5);
});

test('early warning is at 20% and critical agent check is at or below 5%', (t) => {
  resetResources();
  const warnings = [];
  const lowAlerts = [];
  const onWarning = (event) => warnings.push(event);
  const onLow = (event) => lowAlerts.push(event);
  monitor.emitter.on('warning', onWarning);
  monitor.emitter.on('low', onLow);
  t.after(() => {
    monitor.emitter.off('warning', onWarning);
    monitor.emitter.off('low', onLow);
    resetResources();
  });

  setLevel('electricity', 20);
  setLevel('data', 20);
  monitor.tick();
  assert.equal(warnings.length, 2);
  assert.equal(lowAlerts.length, 0);

  setLevel('electricity', electricity.threshold);
  setLevel('data', data.threshold - 1);
  monitor.tick();
  assert.equal(lowAlerts.length, 2);
  assert.deepEqual(
    lowAlerts.map((event) => event.id).sort(),
    ['data', 'electricity'],
  );

  monitor.tick();
  assert.equal(lowAlerts.length, 2, 'low alerts remain latched during cooldown');
});
