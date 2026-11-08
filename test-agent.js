// test-agent.js
// Part 3 verification script:
// 1. Tests parseAndValidateDecision() safety (code fences, clamping, bad JSON fallback to "wait").
// 2. Tests Groq AI decision (askAiDecision) when both electricity and data are low on a tight budget.
// 3. If wallets.json + Supabase are configured, can also run agent.handleLow().

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { askAiDecision, parseAndValidateDecision, handleLow } = require('./agent');
const { setLevel, listResources } = require('./resources');
const { closeXrplClient } = require('./policy-signer');

async function run() {
  console.log('=== GridBot Part 3 Test: Groq AI Agent (llama-3.3-70b-versatile) ===\n');

  // 1. Test safe parser
  console.log('--- Step 1: Testing Safe JSON Parser (code fences, clamping, fallback) ---');
  const fenced = '```json\n{"decision":"buy","resource":"electricity","amount":25,"reason":"Meter is at 3%."}\n```';
  console.log('Fenced + Over-cap (25 clamped to 10):', parseAndValidateDecision(fenced, 'electricity', 10));
  console.log('Malformed JSON fallback to wait:', parseAndValidateDecision('not json at all', 'data', 10));

  // 2. Test live Groq LLM decision when both resources are low and budget is tight (only 5 RLUSD left)
  console.log('\n--- Step 2: Querying Groq (llama-3.3-70b-versatile) with tight budget & both resources low ---');
  setLevel('electricity', 3.5);
  setLevel('data', 6.0);

  const mockContext = {
    lowResource: {
      id: 'data',
      label: 'Router LTE Data Cap (Mock)',
      levelPercent: 6.0,
      thresholdPercent: 10,
      priority: 2,
      unitCostRLUSD: 3,
    },
    allResources: listResources().map((r) => ({
      id: r.id,
      label: r.label,
      levelPercent: r.getLevel(),
      thresholdPercent: r.threshold,
      priority: r.priority,
      unitCostRLUSD: r.unitCostRLUSD,
      isLow: r.getLevel() <= r.threshold,
    })),
    remainingDailyBudgetRLUSD: 5,
    spentTodayRLUSD: 10,
    dailyCapRLUSD: 15,
    perTxCapRLUSD: 10,
    unitCostsRLUSD: { electricity: 5, data: 3 },
    timeOfDay: '16:05:00 SAST (Africa/Johannesburg)',
  };

  const aiProposal = await askAiDecision(mockContext);
  console.log('Groq AI Proposal:', aiProposal);

  // 3. Full handleLow() flow if wallets.json exists
  const walletsPath = path.join(__dirname, 'wallets.json');
  if (fs.existsSync(walletsPath) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    console.log('\n--- Step 3: Running full agent.handleLow("electricity") ---');
    const fullResult = await handleLow({ id: 'electricity' });
    console.log('handleLow() Full Result:', JSON.stringify(fullResult, null, 2));
  } else {
    console.log('\n(Skipping Step 3 full XRPL payment because wallets.json is not yet in d:\\W3\\Internetcafe)');
  }
}

run()
  .catch((err) => {
    console.error('Test error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeXrplClient();
  });
