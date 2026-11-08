// agent.js
// Autonomous AI CFO decision module for GridBot using Groq (llama-3.3-70b-versatile).
//
// HONESTY NOTE:
// This AI agent can ONLY propose actions. It never holds keys, signs, or executes payments.
// Every proposal is sent to the off-chain Policy Signer (policy-signer.js), which checks the
// owner's off-chain daily budget, per-tx cap, and payee allowlist before co-signing on XRPL.
// The XRP Ledger enforces the 2-of-2 multisig quorum on-chain.

require('dotenv').config();
const EventEmitter = require('events');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const { getPolicy, spentToday } = require('./db');
const { requestPayment } = require('./policy-signer');
const { listResources, getResource } = require('./resources');

const MODEL_CANDIDATES = [
  process.env.GROQ_MODEL,
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
].filter(Boolean);

let activeModelName = MODEL_CANDIDATES[0] || 'llama-3.3-70b-versatile';
const MODEL_NAME = activeModelName;
const agentEvents = new EventEmitter();

let groqClient = null;
function getGroqClient() {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Missing GROQ_API_KEY in .env');
    }
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY.trim() });
  }
  return groqClient;
}

const { ensureLocalWalletsFile } = require('./setup-wallets');

function loadUtilityAddress() {
  const wallets = ensureLocalWalletsFile();
  return wallets?.utility?.address;
}

const SYSTEM_PROMPT = `You are GridBot's autonomous AI CFO decision module for a South African small business (internet cafe / co-working space).
Your job is to evaluate low prepaid resource alerts (electricity meter and LTE router data) and return a single JSON proposal.

STRICT RULES:
1. You can ONLY propose. You never sign transactions or move money yourself.
2. When the remaining daily budget is tight and both electricity and data are low (or near low), ALWAYS prioritize "electricity" because electricity also powers the LTE router and cafe computers, and explicitly state in your "reason" that electricity is prioritized because it also powers the router.
3. Never exceed the per-transaction cap (perTxCap) in a single "buy" proposal. If a required purchase needs more than perTxCap (or exceeds the remaining daily budget), choose "escalate" so the business owner can review and sign with their owner key.
4. Output STRICT JSON only. Do NOT wrap in markdown code fences. Do NOT include any text before or after the JSON object.

Required JSON schema:
{
  "decision": "buy" | "wait" | "escalate",
  "resource": "electricity" | "data",
  "amount": number,
  "reason": "one or two plain sentences"
}`;

/**
 * Formats current time in Africa/Johannesburg (SAST).
 */
function getTimeOfDaySAST() {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date()) + ' SAST (Africa/Johannesburg)';
}

/**
 * Safely parses, strips markdown fences, validates fields, and clamps amount.
 * Falls back to "wait" on any malformed output.
 */
function parseAndValidateDecision(rawText, fallbackResource, maxPerTxCap) {
  const validDecisions = ['buy', 'wait', 'escalate'];
  const validResources = ['electricity', 'data'];

  try {
    if (!rawText || typeof rawText !== 'string') {
      throw new Error('Empty response from LLM');
    }

    // Strip <think>...</think> reasoning blocks and markdown code fences if present
    let cleaned = rawText
      .trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Extract first JSON object if extra text leaked around it
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Repair common LLM JSON quirks: trailing commas, unquoted keys, single quotes
      const repaired = cleaned
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      parsed = JSON.parse(repaired);
    }

    const decision = validDecisions.includes(parsed.decision) ? parsed.decision : null;
    const resource = validResources.includes(parsed.resource) ? parsed.resource : fallbackResource;
    const rawAmount = Number(parsed.amount);
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : null;

    if (!decision || !validResources.includes(resource) || !Number.isFinite(rawAmount) || !reason) {
      throw new Error('Missing or invalid fields in parsed JSON');
    }

    // Clamp amount: for "wait", 0; for "buy", clamp between [0.01, maxPerTxCap]; for "escalate", clamp [0.01, 100]
    let amount = Math.round(rawAmount * 100) / 100;
    if (decision === 'wait') {
      amount = 0;
    } else if (decision === 'buy') {
      const cap = Number.isFinite(maxPerTxCap) && maxPerTxCap > 0 ? maxPerTxCap : 10;
      amount = Math.max(0.01, Math.min(amount, cap));
    } else if (decision === 'escalate') {
      amount = Math.max(0.01, Math.min(amount, 100));
    }

    return {
      decision,
      resource,
      amount,
      reason,
      fallback: false,
    };
  } catch (err) {
    console.warn('[Agent] Failed to parse LLM JSON output, falling back to "wait":', err.message);
    return {
      decision: 'wait',
      resource: validResources.includes(fallbackResource) ? fallbackResource : 'electricity',
      amount: 0,
      reason: `Fallback to wait due to invalid AI output (${err.message}).`,
      fallback: true,
    };
  }
}

/**
 * Discovers an available chat model from Groq if our default returns 404 model_not_found.
 */
async function resolveAvailableGroqModel(groq) {
  try {
    const list = await groq.models.list();
    const ids = (list?.data || [])
      .map((m) => m.id)
      .filter((id) => id && !/whisper|tts|guard|embed|playai/i.test(id));

    // Prefer llama-3.3 / llama-4 / gpt-oss / llama-3.1
    const preferred = ids.find((id) => /llama-3\.3|llama-4|gpt-oss|llama-3\.1|qwen|gemma/i.test(id));
    return preferred || ids[0] || null;
  } catch {
    return null;
  }
}

/**
 * Calls Groq to get a structured JSON proposal. Automatically falls back if a model ID is deprecated/restricted.
 */
async function askAiDecision(context) {
  const groq = getGroqClient();
  const userPrompt = JSON.stringify(context, null, 2);

  // Build ordered list starting with the last working model
  const modelsToTry = [
    activeModelName,
    ...MODEL_CANDIDATES.filter((m) => m !== activeModelName),
  ];

  let lastErr = null;

  for (const modelId of modelsToTry) {
    try {
      const completion = await groq.chat.completions.create({
        model: modelId,
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Current prepaid resource alert and budget state:\n${userPrompt}\n\nRespond with STRICT JSON only.`,
          },
        ],
      });

      activeModelName = modelId;
      const content = completion?.choices?.[0]?.message?.content || '';
      return parseAndValidateDecision(content, context.lowResource.id, context.perTxCapRLUSD);
    } catch (err) {
      lastErr = err;
      const isModelNotFound =
        err?.status === 404 || /model_not_found|does not exist/i.test(err?.message || '');
      if (isModelNotFound) {
        console.warn(`[Agent] Model "${modelId}" not available on this Groq key, trying next...`);
        continue;
      }
      break;
    }
  }

  // Last resort: query groq.models.list() for whatever model the API key actually has access to
  try {
    const discoveredModel = await resolveAvailableGroqModel(groq);
    if (discoveredModel) {
      console.log(`[Agent] Auto-selected available Groq model from API: ${discoveredModel}`);
      const completion = await groq.chat.completions.create({
        model: discoveredModel,
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Current prepaid resource alert and budget state:\n${userPrompt}\n\nRespond with STRICT JSON only.`,
          },
        ],
      });
      activeModelName = discoveredModel;
      const content = completion?.choices?.[0]?.message?.content || '';
      return parseAndValidateDecision(content, context.lowResource.id, context.perTxCapRLUSD);
    }
  } catch (err) {
    lastErr = err;
  }

  console.error('[Agent] Groq API error, falling back to "wait":', lastErr?.message);
  return {
    decision: 'wait',
    resource: context?.lowResource?.id || 'electricity',
    amount: 0,
    reason: `Fallback to wait because Groq AI request failed: ${lastErr?.message || 'unknown error'}.`,
    fallback: true,
  };
}

// ============================================================================
// Rogue Mode State (Runaway Agent Demo)
// ============================================================================
let rogueMode = false;
let rogueTimer = null;
let rogueInFlight = false;
let rogueCounter = 0;

function isRogueMode() {
  return rogueMode;
}

/**
 * Single rogue mode tick: skips AI and fires a buy request directly to Policy Signer.
 */
async function runRogueTick() {
  if (!rogueMode || rogueInFlight) return;
  rogueInFlight = true;
  rogueCounter += 1;

  try {
    const resourceId = rogueCounter % 2 === 1 ? 'electricity' : 'data';
    const plugin = getResource(resourceId);
    const amount = plugin.unitCostRLUSD; // e.g., 5 RLUSD or 3 RLUSD
    const payee = loadUtilityAddress();
    const reason = `[ROGUE MODE #${rogueCounter}] Unchecked runaway agent attempting rapid purchase of ${resourceId} (${amount} RLUSD)`;

    const paymentResult = await requestPayment({
      resource: resourceId,
      amount,
      payee,
      reason,
    });

    let vendResult = null;
    if (paymentResult.status === 'auto_approved' || paymentResult.status === 'owner_approved') {
      vendResult = plugin.vend(amount);
    }

    const fullResult = {
      mode: 'rogue',
      timestamp: new Date().toISOString(),
      proposal: {
        decision: 'buy',
        resource: resourceId,
        amount,
        reason,
      },
      payment: paymentResult,
      vend: vendResult,
    };

    agentEvents.emit('decision', fullResult);
  } catch (err) {
    console.error('[Agent Rogue Mode] Tick error:', err.message);
  } finally {
    rogueInFlight = false;
  }
}

/**
 * Toggles Rogue Mode on or off.
 * When ON, skips AI and fires a buy request every 1 second in a loop so the
 * off-chain Policy Signer rapidly hits the daily cap and blocks/queues excess spend.
 */
function setRogueMode(enabled) {
  rogueMode = Boolean(enabled);

  if (rogueMode) {
    if (!rogueTimer) {
      rogueCounter = 0;
      // Fire immediately then every 1000ms
      runRogueTick();
      rogueTimer = setInterval(runRogueTick, 1000);
    }
  } else if (rogueTimer) {
    clearInterval(rogueTimer);
    rogueTimer = null;
  }

  agentEvents.emit('rogue', { rogueMode });
  return rogueMode;
}

// ============================================================================
// Main Low-Resource Handler
// ============================================================================

/**
 * Handles a 'low' event from monitor.js (or a manual trigger).
 * 1. Gathers all resource levels, remaining daily budget, per-tx cap, unit costs, and time of day.
 * 2. Queries Groq (llama-3.3-70b-versatile) for a JSON proposal (unless rogue mode is active).
 * 3. If decision is "buy" or "escalate", calls requestPayment() on the Policy Signer.
 * 4. If payment is auto_approved or owner_approved, calls the resource plugin's vend(amount).
 * 5. Returns a complete result object and emits 'decision' on agentEvents.
 *
 * @param {object|string} lowEventOrResourceId - Event payload from monitor 'low' or resource id string
 */
async function handleLow(lowEventOrResourceId) {
  const resourceId =
    typeof lowEventOrResourceId === 'string'
      ? lowEventOrResourceId
      : lowEventOrResourceId?.id || 'electricity';

  const lowPlugin = getResource(resourceId);

  // Gather policy and budget state
  const policy = await getPolicy();
  const spent = await spentToday();
  const dailyCap = Number(policy.daily_cap);
  const perTxCap = Number(policy.per_tx_cap);
  const remainingDailyBudget = Math.max(0, Math.round((dailyCap - spent) * 1e6) / 1e6);

  // Gather ALL resource levels and unit costs
  const allResources = listResources().map((r) => ({
    id: r.id,
    label: r.label,
    levelPercent: r.getLevel(),
    thresholdPercent: r.threshold,
    priority: r.priority,
    unitCostRLUSD: r.unitCostRLUSD,
    isLow: r.getLevel() <= r.threshold,
  }));

  const unitCosts = {};
  for (const r of allResources) {
    unitCosts[r.id] = r.unitCostRLUSD;
  }

  const context = {
    lowResource: {
      id: lowPlugin.id,
      label: lowPlugin.label,
      levelPercent: lowPlugin.getLevel(),
      thresholdPercent: lowPlugin.threshold,
      priority: lowPlugin.priority,
      unitCostRLUSD: lowPlugin.unitCostRLUSD,
    },
    allResources,
    remainingDailyBudgetRLUSD: remainingDailyBudget,
    spentTodayRLUSD: spent,
    dailyCapRLUSD: dailyCap,
    perTxCapRLUSD: perTxCap,
    unitCostsRLUSD: unitCosts,
    timeOfDay: getTimeOfDaySAST(),
  };

  let proposal;
  if (rogueMode) {
    proposal = {
      decision: 'buy',
      resource: lowPlugin.id,
      amount: lowPlugin.unitCostRLUSD,
      reason: '[ROGUE MODE] Skipping AI analysis and firing immediate buy request.',
      fallback: false,
    };
  } else {
    proposal = await askAiDecision(context);
  }

  const targetPlugin = getResource(proposal.resource);
  const payee = policy.allowed_payees?.[0] || loadUtilityAddress();

  let paymentResult = null;
  let vendResult = null;

  if (proposal.decision === 'buy' || proposal.decision === 'escalate') {
    // Even if the AI chose "escalate" (or "buy"), requestPayment() enforces all caps and allowlist:
    // - If within caps -> signs (agent + policy) -> auto_approved
    // - If over per_tx_cap or daily_cap -> logs pending_owner for owner signature
    const amountToRequest =
      proposal.amount > 0 ? proposal.amount : targetPlugin.unitCostRLUSD;

    paymentResult = await requestPayment({
      resource: targetPlugin.id,
      amount: amountToRequest,
      payee,
      reason: proposal.reason,
    });

    if (
      paymentResult &&
      (paymentResult.status === 'auto_approved' || paymentResult.status === 'owner_approved')
    ) {
      vendResult = targetPlugin.vend(amountToRequest);
    }
  } else {
    // decision === 'wait' -> no payment requested
    paymentResult = {
      status: 'waited',
      reason: proposal.reason,
    };
  }

  const fullResult = {
    mode: rogueMode ? 'rogue' : 'ai',
    timestamp: new Date().toISOString(),
    triggerResource: lowPlugin.id,
    context,
    proposal,
    payment: paymentResult,
    vend: vendResult,
  };

  agentEvents.emit('decision', fullResult);
  return fullResult;
}

module.exports = {
  handleLow,
  askAiDecision,
  parseAndValidateDecision,
  setRogueMode,
  isRogueMode,
  agentEvents,
  MODEL_NAME,
};
