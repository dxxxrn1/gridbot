// agent.js
// Autonomous AI CFO decision module for GridBot using Groq (llama-3.3-70b-versatile).
//
// HONESTY NOTE:
// This AI agent can ONLY propose actions and sign with its weight-1 agent key via policy-client.js.
// Every proposal is sent to the independent Policy Service (port 4000), which enforces the
// off-chain daily budget, per-tx cap, velocity limit, and payee allowlist before co-signing.
// The XRP Ledger enforces the 2-of-2 multisig quorum on-chain.

require('dotenv').config();
const EventEmitter = require('events');
const Groq = require('groq-sdk');

const { requestPayment, getState, loadPublicWallets } = require('./policy-client');
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

function loadUtilityAddress() {
  const pub = loadPublicWallets();
  return pub?.utility?.address;
}

function calcRlusdNeededToRefill(level, percentPerRLUSD) {
  const missing = Math.max(0, 100 - Number(level || 0));
  const rate = Number(percentPerRLUSD) || 20;
  return Math.ceil((missing / rate) * 100) / 100;
}

const SYSTEM_PROMPT = `You are GridBot's autonomous AI CFO decision module for a South African small business (internet cafe / co-working space).
Your job is to evaluate low prepaid resource alerts (electricity meter and LTE router data) and return a single JSON proposal.

STRICT RULES:
1. You can ONLY propose. You never co-sign policy rules or move money by yourself.
2. The proposed "amount" should be the RLUSD needed to refill the target resource to about 100% (use the provided rlusdNeededToRefill field), capped at perTxCapRLUSD.
3. Never exceed perTxCapRLUSD in a single "buy" proposal; if more than perTxCapRLUSD is needed (or if it exceeds remainingDailyBudgetRLUSD), either propose up to perTxCapRLUSD or choose "escalate".
4. If both resources are low and the remaining daily budget cannot cover both, ALWAYS buy "electricity" first (because electricity also powers the LTE router and cafe computers) and explicitly say so in the "reason".
5. Never switch to a different resource than the triggered lowResource without explicitly explaining why in the "reason".
6. Output STRICT JSON only. No markdown code fences.

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
  return (
    new Intl.DateTimeFormat('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date()) + ' SAST (Africa/Johannesburg)'
  );
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

    let cleaned = rawText
      .trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
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

async function resolveAvailableGroqModel(groq) {
  try {
    const list = await groq.models.list();
    const ids = (list?.data || [])
      .map((m) => m.id)
      .filter((id) => id && !/whisper|tts|guard|embed|playai/i.test(id));

    const preferred = ids.find((id) => /llama-3\.3|llama-4|gpt-oss|llama-3\.1|qwen|gemma/i.test(id));
    return preferred || ids[0] || null;
  } catch {
    return null;
  }
}

async function askAiDecision(context) {
  const groq = getGroqClient();
  const userPrompt = JSON.stringify(context, null, 2);

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
 * Single rogue mode tick: skips AI and fires a buy request every second to the Policy Service.
 */
async function runRogueTick() {
  if (!rogueMode || rogueInFlight) return;
  rogueInFlight = true;
  rogueCounter += 1;

  try {
    const resourceId = rogueCounter % 2 === 1 ? 'electricity' : 'data';
    const plugin = getResource(resourceId);
    const amount = plugin.unitCostRLUSD;
    const payee = loadUtilityAddress();
    const reason = `[ROGUE MODE #${rogueCounter}] Runaway agent attempting rapid purchase of ${resourceId} (${amount} RLUSD)`;

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

function setRogueMode(enabled) {
  rogueMode = Boolean(enabled);

  if (rogueMode) {
    if (!rogueTimer) {
      rogueCounter = 0;
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

async function handleLow(lowEventOrResourceId) {
  const resourceId =
    typeof lowEventOrResourceId === 'string'
      ? lowEventOrResourceId
      : lowEventOrResourceId?.id || 'electricity';

  const lowPlugin = getResource(resourceId);

  const state = await getState();
  const policy = state.policy;
  const spent = Number(state.spentToday || 0);
  const dailyCap = Number(policy.daily_cap);
  const perTxCap = Number(policy.per_tx_cap);
  const remainingDailyBudget =
    state.budgetRemaining !== undefined
      ? Number(state.budgetRemaining)
      : Math.max(0, Math.round((dailyCap - spent) * 1e6) / 1e6);

  const allResources = listResources().map((r) => {
    const levelPercent = r.getLevel();
    const percentPerRLUSD = r.percentPerRLUSD;
    const rlusdNeededToRefill = calcRlusdNeededToRefill(levelPercent, percentPerRLUSD);
    return {
      id: r.id,
      label: r.label,
      levelPercent,
      thresholdPercent: r.threshold,
      priority: r.priority,
      unitCostRLUSD: r.unitCostRLUSD,
      percentPerRLUSD,
      rlusdNeededToRefill,
      isLow: levelPercent <= r.threshold,
    };
  });

  const unitCosts = {};
  for (const r of allResources) {
    unitCosts[r.id] = r.unitCostRLUSD;
  }

  const lowLevelPercent = lowPlugin.getLevel();
  const lowRlusdNeeded = calcRlusdNeededToRefill(lowLevelPercent, lowPlugin.percentPerRLUSD);

  const context = {
    lowResource: {
      id: lowPlugin.id,
      label: lowPlugin.label,
      levelPercent: lowLevelPercent,
      thresholdPercent: lowPlugin.threshold,
      priority: lowPlugin.priority,
      unitCostRLUSD: lowPlugin.unitCostRLUSD,
      percentPerRLUSD: lowPlugin.percentPerRLUSD,
      rlusdNeededToRefill: lowRlusdNeeded,
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
      amount: Math.min(perTxCap, lowRlusdNeeded || lowPlugin.unitCostRLUSD),
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
    const targetNeeded = calcRlusdNeededToRefill(
      targetPlugin.getLevel(),
      targetPlugin.percentPerRLUSD
    );
    const amountToRequest =
      proposal.amount > 0 ? proposal.amount : Math.min(perTxCap, targetNeeded || targetPlugin.unitCostRLUSD);

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
  calcRlusdNeededToRefill,
  setRogueMode,
  isRogueMode,
  agentEvents,
  MODEL_NAME,
};
