// test-monitor.js
// Part 2 verification script:
// Forces resources near their thresholds, starts monitor.js (2-second ticks),
// prints 'level' updates, catches 'low' events (proving they only fire once per low episode),
// then calls vend() to refill and show the latch resetting.

const { electricity, data, setLevel } = require('./resources');
const { emitter, start, stop } = require('./monitor');

console.log('=== GridBot Part 2 Test: Resource Plugins & Monitor ===\n');

// Force-set starting levels just above thresholds so we see them cross threshold within a couple of ticks
setLevel('electricity', 8.0); // threshold is 5%
setLevel('data', 13.5);       // threshold is 10%

console.log(
  `Initial forced levels -> Electricity: ${electricity.getLevel()}% (threshold ${electricity.threshold}%), ` +
  `Data: ${data.getLevel()}% (threshold ${data.threshold}%)\n`
);

let tickCount = 0;

emitter.on('level', (snapshot) => {
  tickCount += 1;
  const summary = snapshot
    .map((r) => `${r.id}: ${r.level.toFixed(1)}% (thresh ${r.threshold}%)`)
    .join(' | ');
  console.log(`[Tick #${tickCount}] 'level' -> ${summary}`);
});

emitter.on('low', (event) => {
  console.log(
    `\n🚨 [ALERT 'low' EVENT] ${event.label} (${event.id}) dropped to ${event.level}% ` +
    `(threshold: ${event.threshold}%, priority: ${event.priority}, unitCost: ${event.unitCostRLUSD} RLUSD)`
  );

  // Wait 3 seconds (so another tick happens while still low, proving 'low' does NOT fire twice),
  // then vend() to refill back to 100%.
  setTimeout(() => {
    const vendResult = event.resource.vend(event.unitCostRLUSD);
    if (vendResult.token) {
      console.log(
        `⚡ [VEND ELECTRICITY] Refilled to ${ event.resource.getLevel() }%! STS Token: ${vendResult.token}\n`
      );
    } else if (vendResult.bundle) {
      console.log(
        `📶 [VEND DATA] Refilled to ${ event.resource.getLevel() }%! Bundle: ${vendResult.bundle}\n`
      );
    }
  }, 3000);
});

start(2000);

// Stop automatically after 12 seconds
setTimeout(() => {
  stop();
  console.log('\n=== Monitor test complete (stopped after 12s) ===');
}, 12000);
