// telegram.js
// Lightweight, 100% fail-safe Telegram Bot client for the GridBot Main App using native fetch.
// Supports outbound alerts (notifyLowWarning, notifyAutoApproved, notifyPendingOwner),
// an interactive Owner Control Panel menu in Telegram, and 2.5s background getUpdates polling
// for inline button callbacks (approve:<id>, reject:<id>, topup:<res>, menu:<action>) and commands.

const dns = require("dns");
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}
require("dotenv").config();

const {
  getState,
  getTx,
  proxyOwnerApprove,
  proxyOwnerReject,
} = require("./policy-client");
const { getResource, listResources } = require("./resources");

const XRPL_EXPLORER_BASE = (
  process.env.XRPL_EXPLORER_BASE || "https://testnet.xrpl.org/transactions"
).replace(/\/$/, "");

const POLL_INTERVAL_MS = 1000;

let pollTimer = null;
let pollInFlight = false;
let lastUpdateId = 0;
let onStateChangedCallback = null;
const pendingPinActions = new Map();
let topupInFlight = false;

const ENV_OWNER_PASSCODE = (process.env.OWNER_PASSCODE || "").trim();
const ENV_STAFF_PASSCODE = (process.env.STAFF_PASSCODE || "").trim();
if (!ENV_OWNER_PASSCODE || ENV_OWNER_PASSCODE.length < 6) {
  throw new Error(
    "[Telegram] Startup refused: OWNER_PASSCODE must be set in .env and at least 6 characters long.",
  );
}
if (!ENV_STAFF_PASSCODE || ENV_STAFF_PASSCODE.length < 6) {
  throw new Error(
    "[Telegram] Startup refused: STAFF_PASSCODE must be set in .env and at least 6 characters long.",
  );
}

function getConfig() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (
    process.env.TELEGRAM_CHAT_ID ||
    process.env.OWNER_CHAT_ID ||
    ""
  ).trim();
  const allowedChatIds = new Set(
    String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || chatId)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (chatId) allowedChatIds.add(chatId);
  const telegramApprovePin = (process.env.TELEGRAM_APPROVE_PIN || "").trim();
  return {
    token,
    chatId,
    allowedChatIds,
    telegramApprovePin,
    enabled: Boolean(token && chatId),
  };
}

function explorerUrl(txHash) {
  if (!txHash) return null;
  return `${XRPL_EXPLORER_BASE}/${txHash}`;
}

/**
 * Escapes characters that break Telegram legacy Markdown ('_', '*', '`', '[').
 */
function cleanMd(val) {
  if (val === null || val === undefined) return "";
  return String(val).replace(/[_*`[\]]/g, (ch) => (ch === "_" ? "-" : ""));
}

/**
 * Standard Owner Control Panel inline keyboard buttons shown in Telegram.
 */
function getOwnerMenuInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status & Meters", callback_data: "menu:status" },
        { text: "⏳ Pending Approvals", callback_data: "menu:pending" },
      ],
      [
        {
          text: "⚡ Top Up Electricity (5 RLUSD)",
          callback_data: "topup:electricity",
        },
        { text: "📶 Top Up LTE Data (3 RLUSD)", callback_data: "topup:data" },
      ],
    ],
  };
}

/**
 * Calls the Telegram Bot HTTP API (`https://api.telegram.org/bot<TOKEN>/<method>`) via native fetch.
 * Never throws; returns `{ ok: false }` on any network or API error.
 */
let lastGetUpdatesErrAt = 0;
async function callTelegramApi(method, body = {}) {
  const { token, enabled } = getConfig();
  if (!enabled) return { ok: false, disabled: true };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      const desc = String(data.description || "");
      if (method === "getUpdates") {
        const now = Date.now();
        if (now - lastGetUpdatesErrAt > 30000) {
          lastGetUpdatesErrAt = now;
          console.warn(`[Telegram API] getUpdates error:`, desc || data);
        }
      } else if (
        !desc.includes("query is too old") &&
        !desc.includes("message is not modified") &&
        !desc.includes("parse entities")
      ) {
        console.warn(`[Telegram API] ${method} returned error:`, desc || data);
      }
    }
    return data;
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (
      !msg.includes("fetch failed") &&
      !msg.includes("ECONNRESET") &&
      !msg.includes("ETIMEDOUT") &&
      !msg.includes("ENOTFOUND") &&
      !msg.includes("UND_ERR")
    ) {
      console.warn(`[Telegram API] ${method} warning:`, msg);
    }
    return { ok: false, error: msg };
  }
}

/**
 * Sends a text message to the configured TELEGRAM_CHAT_ID.
 * Automatically retries as plain text if Markdown entity parsing fails.
 */
async function sendTelegramMessage(text, extra = {}) {
  const { chatId, enabled } = getConfig();
  if (!enabled) return { ok: false, disabled: true };

  const res = await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...extra,
  });

  if (!res.ok && String(res.description || "").includes("parse entities")) {
    return callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: String(text).replace(/[*`]/g, ""),
      disable_web_page_preview: true,
      ...extra,
    });
  }

  return res;
}

/**
 * Deletes a message (e.g. temporary "Processing..." notice) safely.
 */
async function deleteTelegramMessage(chatId, messageId) {
  if (!messageId) return { ok: false };
  const targetChatId = chatId || getConfig().chatId;
  if (!targetChatId) return { ok: false };
  return callTelegramApi("deleteMessage", {
    chat_id: targetChatId,
    message_id: messageId,
  });
}

/**
 * Sends the interactive Owner Control Panel to Telegram with live meter levels & budget.
 */
async function sendOwnerControlMenu(
  titlePrefix = "🎛️ *GridBot Owner Control Panel*",
) {
  const { enabled } = getConfig();
  if (!enabled) return;

  try {
    const state = await getState();
    const policy = state?.policy || {};
    const spent = Number(state?.spentToday ?? 0);
    const remaining = Number(state?.budgetRemaining ?? 15);
    const pendingList = (state?.transactions || []).filter(
      (t) => t.status === "pending_owner",
    );

    const resources = listResources();
    const meterLines = resources.map((r) => {
      const lvl = Math.round(r.getLevel());
      const icon = r.id === "electricity" ? "⚡" : "📶";
      const tag =
        lvl <= r.threshold
          ? "🚨 CRITICAL"
          : lvl <= 20
            ? "⚠️ LOW (<=20%)"
            : "✅ Healthy";
      return `• ${icon} *${cleanMd(r.label)}:* ${lvl}% (${tag})`;
    });

    const lines = [
      titlePrefix,
      "",
      `*Live Prepaid Meters:*`,
      ...meterLines,
      "",
      `*Daily Treasury Policy:*`,
      `• *Spent Today:* ${spent} RLUSD`,
      `• *Remaining Budget:* ${remaining} RLUSD (Daily Cap: ${policy.daily_cap ?? 15} RLUSD)`,
      `• *Per-Payment Cap:* ${policy.per_tx_cap ?? 10} RLUSD`,
      `• *Pending Owner Approvals:* ${pendingList.length}`,
      "",
      `👇 *Select an Owner action below:*`,
    ];

    await sendTelegramMessage(lines.join("\n"), {
      reply_markup: getOwnerMenuInlineKeyboard(),
    });
  } catch (err) {
    console.warn("[Telegram sendOwnerControlMenu] Warning:", err.message);
  }
}

/**
 * Lists all `pending_owner` transactions in Telegram with Approve / Reject buttons.
 */
async function sendPendingApprovalsList() {
  const { enabled } = getConfig();
  if (!enabled) return;

  try {
    const state = await getState();
    const pendingList = (state?.transactions || []).filter(
      (t) => t.status === "pending_owner",
    );

    if (pendingList.length === 0) {
      await sendTelegramMessage(
        `✅ *No Pending Approvals*\nAll utility requests are currently settled or within policy caps.`,
        { reply_markup: getOwnerMenuInlineKeyboard() },
      );
      return;
    }

    for (const tx of pendingList.slice(0, 5)) {
      await notifyPendingOwner({
        id: tx.id,
        resource: tx.resource,
        amount: tx.amount,
        reason: tx.reason,
        blockedReason: tx.blocked_reason,
        remainingBudget: state?.budgetRemaining,
        requestedBy: "Queued Request",
      });
    }
  } catch (err) {
    console.warn("[Telegram sendPendingApprovalsList] Warning:", err.message);
  }
}

/**
 * 4. notifyAutoApproved({ resource, amount, reason, txHash, vend, requestedBy })
 */
async function notifyAutoApproved({
  resource,
  amount,
  reason,
  txHash,
  vend,
  requestedBy,
  title,
} = {}) {
  const { enabled } = getConfig();
  if (!enabled) return { ok: false, disabled: true };

  try {
    const link = explorerUrl(txHash);
    const lines = [
      title || `✅ *GridBot Auto-Approved Purchase*`,
      `• *Requested By:* ${cleanMd(requestedBy || "Autonomous Monitor")}`,
      `• *Resource & Amount:* ${amount} RLUSD for ${cleanMd(resource)}`,
      `• *Reason:* ${cleanMd(reason || "Low balance auto-refill")}`,
    ];

    if (vend?.token) {
      lines.push(`• *Vending Receipt (STS Token):* \`${vend.token}\``);
    } else if (vend?.bundle) {
      lines.push(`• *Vending Receipt (Data Bundle):* ${cleanMd(vend.bundle)}`);
    }

    if (link) {
      lines.push(`• *XRPL Testnet:* [View Transaction](${link})`);
    }

    return await sendTelegramMessage(lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎛️ Open Owner Control Menu",
              callback_data: "menu:status",
            },
          ],
        ],
      },
    });
  } catch (err) {
    console.warn("[Telegram notifyAutoApproved] Warning:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Early 20% low-balance warning notification with a 1-tap "Top Up Now" button.
 */
async function notifyLowWarning({
  id,
  label,
  level,
  warnThreshold = 20,
  criticalThreshold = 5,
  unitCostRLUSD = 5,
} = {}) {
  const { enabled } = getConfig();
  if (!enabled) return;

  try {
    const icon = id === "electricity" ? "⚡" : "📶";
    const lines = [
      `🔔 *GridBot Early Low-Balance Alert (${level}%)*`,
      `• *Resource:* ${icon} ${cleanMd(label || id)}`,
      `• *Current Level:* *${level}%* (Warning at ${warnThreshold}%, Auto-buy at ${criticalThreshold}%)`,
      `• *Standard Top-Up:* ${unitCostRLUSD} RLUSD`,
      `• *Action:* Tap below to top up proactively before reaching critical level, or let GridBot auto-top-up at ${criticalThreshold}%.`,
    ];

    await sendTelegramMessage(lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `${icon} Top Up ${id === "electricity" ? "Electricity" : "LTE Data"} Now (${unitCostRLUSD} RLUSD)`,
              callback_data: `topup:${id}`,
            },
          ],
          [{ text: "🎛️ Owner Control Menu", callback_data: "menu:status" }],
        ],
      },
    });
  } catch (err) {
    console.warn("[Telegram notifyLowWarning] Warning:", err.message);
  }
}

/**
 * 5. notifyPendingOwner({ id, resource, amount, reason, blockedReason, remainingBudget, requestedBy })
 */
async function notifyPendingOwner({
  id,
  resource,
  amount,
  reason,
  blockedReason,
  remainingBudget,
  requestedBy,
} = {}) {
  const { enabled } = getConfig();
  if (!enabled) return;

  try {
    let rem = remainingBudget;
    if (rem === undefined) {
      const state = await getState();
      rem = Number(state?.budgetRemaining ?? 0);
    }

    const lines = [
      `⚠️ *GridBot Owner Approval Needed (Over Cap)*`,
      `• *Tx ID:* #${id} | *Requested By:* ${cleanMd(requestedBy || "Staff / Agent")}`,
      `• *Resource:* ${cleanMd(resource)} | *Amount:* ${amount} RLUSD`,
      `• *Reason:* ${cleanMd(reason || "Resource refill request")}`,
      `• *Rule Triggered:* ${cleanMd(blockedReason || "Policy cap exceeded")}`,
      `• *Remaining Daily Budget:* ${rem} RLUSD`,
      "",
      `👇 *Tap Approve to co-sign with Owner key (weight 2) or Reject:*`,
    ];

    return await sendTelegramMessage(lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `✅ Approve #${id} (${amount} RLUSD)`,
              callback_data: `approve:${id}`,
            },
            { text: `❌ Reject #${id}`, callback_data: `reject:${id}` },
          ],
          [{ text: "🎛️ Owner Control Menu", callback_data: "menu:status" }],
        ],
      },
    });
  } catch (err) {
    console.warn("[Telegram notifyPendingOwner] Warning:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Shared handler for owner approve action (triggered by inline button or `/approve <id>`).
 */
async function handleOwnerApproveAction(
  rawId,
  { callbackQueryId, messageId, incomingChatId, pin } = {},
) {
  const txId = /^\d+$/.test(String(rawId)) ? Number(rawId) : rawId;
  const { chatId, allowedChatIds, telegramApprovePin } = getConfig();
  const targetChatId = incomingChatId || chatId;

  if (!allowedChatIds.has(String(targetChatId))) {
    await sendTelegramMessage("⛔ Unauthorized chat ID for Telegram approval.");
    return;
  }

  if (!telegramApprovePin || String(pin || "").trim() !== telegramApprovePin) {
    await sendTelegramMessage(
      telegramApprovePin
        ? `🔐 Invalid or missing approval PIN for #${txId}. Send \`/approve ${txId} <PIN>\` or click Approve and enter your PIN.`
        : "⚠️ Telegram approvals are disabled: `TELEGRAM_APPROVE_PIN` is not configured in `.env`.",
    );
    return;
  }

  if (callbackQueryId) {
    await callTelegramApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: `Processing approval for #${txId}...`,
    });
  }

  const tx = await getTx(txId);
  if (!tx) {
    await sendTelegramMessage(`⚠️ Transaction #${txId} not found.`);
    return;
  }

  if (tx.status !== "pending_owner") {
    if (messageId) {
      await callTelegramApi("editMessageReplyMarkup", {
        chat_id: targetChatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    }
    await sendTelegramMessage(
      `ℹ️ Transaction #${txId} is already \`${tx.status}\`.`,
    );
    return;
  }

  const { ok, data: approveResult } = await proxyOwnerApprove(txId, null, {
    pin: telegramApprovePin,
    chatId: targetChatId,
  });

  if (ok && approveResult?.status === "owner_approved") {
    let vend = null;
    try {
      const resourcePlugin = getResource(tx.resource);
      vend = resourcePlugin.vend(tx.amount);
    } catch (vendErr) {
      console.warn(
        "[Telegram] Vend warning after owner approval:",
        vendErr.message,
      );
    }

    if (messageId) {
      await callTelegramApi("editMessageReplyMarkup", {
        chat_id: targetChatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    }

    const link = explorerUrl(approveResult.txHash);
    const replyLines = [
      `✅ *Owner Approved #${txId}*`,
      `• *Resource:* ${cleanMd(tx.resource)} (${tx.amount} RLUSD)`,
      `• *TX Hash:* \`${approveResult.txHash}\``,
    ];

    if (vend?.token) {
      replyLines.push(`• *STS Token:* \`${vend.token}\``);
    } else if (vend?.bundle) {
      replyLines.push(`• *Data Bundle:* ${cleanMd(vend.bundle)}`);
    }

    if (link) {
      replyLines.push(`• [View on XRPL Testnet](${link})`);
    }

    await sendTelegramMessage(replyLines.join("\n"), {
      reply_markup: getOwnerMenuInlineKeyboard(),
    });

    if (typeof onStateChangedCallback === "function") {
      await onStateChangedCallback({
        type: "owner_approved",
        txId,
        resource: tx.resource,
        amount: tx.amount,
        approveResult,
        vend,
      });
    }
  } else {
    const errReason =
      approveResult?.error ||
      approveResult?.reason ||
      "Check OWNER_PASSCODE in .env or approve from dashboard";
    await sendTelegramMessage(
      `❌ *Approval Failed for #${txId}:* ${cleanMd(errReason)}`,
    );
  }
}

/**
 * Shared handler for owner reject action (triggered by inline button or `/reject <id>`).
 */
async function handleOwnerRejectAction(
  rawId,
  { callbackQueryId, messageId, incomingChatId, pin } = {},
) {
  const txId = /^\d+$/.test(String(rawId)) ? Number(rawId) : rawId;
  const { chatId, allowedChatIds, telegramApprovePin } = getConfig();
  const targetChatId = incomingChatId || chatId;

  if (!allowedChatIds.has(String(targetChatId))) {
    await sendTelegramMessage(
      "⛔ Unauthorized chat ID for Telegram rejection.",
    );
    return;
  }

  if (!telegramApprovePin || String(pin || "").trim() !== telegramApprovePin) {
    await sendTelegramMessage(
      telegramApprovePin
        ? `🔐 Invalid or missing approval PIN for #${txId}. Send \`/reject ${txId} <PIN>\` or click Reject and enter your PIN.`
        : "⚠️ Telegram approvals are disabled: `TELEGRAM_APPROVE_PIN` is not configured in `.env`.",
    );
    return;
  }

  const { ok, data: rejectResult } = await proxyOwnerReject(txId, null, {
    pin: telegramApprovePin,
    chatId: targetChatId,
  });

  if (callbackQueryId) {
    await callTelegramApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: ok ? `Rejected #${txId}` : "Reject failed",
    });
  }

  if (ok) {
    if (messageId) {
      await callTelegramApi("editMessageReplyMarkup", {
        chat_id: targetChatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    }

    await sendTelegramMessage(
      `❌ *Transaction #${txId} was rejected by owner.*`,
      {
        reply_markup: getOwnerMenuInlineKeyboard(),
      },
    );

    if (typeof onStateChangedCallback === "function") {
      await onStateChangedCallback({
        type: "owner_rejected",
        txId,
      });
    }
  } else {
    const errReason =
      rejectResult?.error ||
      rejectResult?.reason ||
      "Check OWNER_PASSCODE in .env or reject from dashboard";
    await sendTelegramMessage(
      `⚠️ *Reject Failed for #${txId}:* ${cleanMd(errReason)}`,
    );
  }
}

/**
 * Triggers a manual/proactive owner top-up from Telegram (inline button or /topup_* command).
 */
async function triggerProactiveTopup({
  resource,
  incomingChatId,
  callbackQueryId,
} = {}) {
  const { chatId, allowedChatIds, telegramApprovePin } = getConfig();
  const targetChatId = String(incomingChatId || chatId || "");
  if (!allowedChatIds.has(targetChatId)) {
    if (callbackQueryId) {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "Unauthorized chat ID.",
        show_alert: true,
      });
    }
    return;
  }

  if (topupInFlight) {
    if (callbackQueryId) {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "⏳ A top-up is already in progress, please wait...",
      });
    } else {
      await sendTelegramMessage(
        "⏳ A top-up is already in progress, please wait...",
      );
    }
    return;
  }

  topupInFlight = true;
  try {
    if (callbackQueryId) {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: `Triggering proactive ${resource} top-up...`,
      });
    }

    const label = resource === "data" ? "LTE Data" : "Electricity";
    const processingMsg = await sendTelegramMessage(
      `⏳ Processing manual *${label}* top-up (signing on XRPL, ~10-20s)...`,
    );
    const processingMsgId = processingMsg?.result?.message_id || null;
    const telegramAuth = telegramApprovePin
      ? { pin: telegramApprovePin, chatId: targetChatId }
      : null;

    if (typeof onStateChangedCallback === "function") {
      try {
        await Promise.race([
          onStateChangedCallback({
            type: "proactive_topup",
            resource,
            processingMsgId,
            chatId: targetChatId,
            telegramAuth,
          }),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Top-up timed out after 45s (ledger or policy service slow/unreachable)",
                  ),
                ),
              45000,
            ),
          ),
        ]);
      } catch (err) {
        console.error("[Telegram] topup error:", err?.message || err);
        const errRes = await sendTelegramMessage(
          `❌ *Top-Up Failed:* ${cleanMd(err?.message || "unknown error")}`,
          { reply_markup: getOwnerMenuInlineKeyboard() },
        );
        if (errRes?.ok && processingMsgId) {
          await deleteTelegramMessage(targetChatId, processingMsgId);
        }
      }
    } else {
      const warnRes = await sendTelegramMessage(
        "⚠️ Top-up handler is not initialized yet.",
        { reply_markup: getOwnerMenuInlineKeyboard() },
      );
      if (warnRes?.ok && processingMsgId) {
        await deleteTelegramMessage(targetChatId, processingMsgId);
      }
    }
  } finally {
    topupInFlight = false;
  }
}

/**
 * Processes a single update from Telegram `getUpdates`.
 */
async function processUpdate(update) {
  const { allowedChatIds, telegramApprovePin } = getConfig();

  // 1. Handle inline keyboard button clicks (callback_query)
  if (update.callback_query) {
    const cb = update.callback_query;
    const incomingChatId = String(cb?.message?.chat?.id || "");
    if (!allowedChatIds.has(incomingChatId)) {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Unauthorized chat ID.",
        show_alert: true,
      });
      return;
    }

    const data = String(cb.data || "");
    console.log(
      `[Telegram] Callback received: "${data}" from chat ${incomingChatId}`,
    );
    const [action, rawId] = data.split(":");
    const messageId = cb?.message?.message_id;

    if ((action === "approve" || action === "reject") && rawId) {
      if (!telegramApprovePin) {
        await callTelegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "TELEGRAM_APPROVE_PIN is not set in .env",
          show_alert: true,
        });
        await sendTelegramMessage(
          "⚠️ Telegram approvals are disabled: `TELEGRAM_APPROVE_PIN` is not configured in `.env`.",
        );
        return;
      }

      if (action === "approve") {
        await handleOwnerApproveAction(rawId, {
          callbackQueryId: cb.id,
          messageId,
          incomingChatId,
          pin: telegramApprovePin,
        });
      } else {
        await handleOwnerRejectAction(rawId, {
          callbackQueryId: cb.id,
          messageId,
          incomingChatId,
          pin: telegramApprovePin,
        });
      }
    } else if (action === "menu") {
      await callTelegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text:
          rawId === "pending"
            ? "Loading pending approvals..."
            : "Refreshing status...",
      });
      if (rawId === "pending") {
        await sendPendingApprovalsList();
      } else {
        await sendOwnerControlMenu();
      }
    } else if (
      action === "topup" &&
      (rawId === "electricity" || rawId === "data")
    ) {
      await triggerProactiveTopup({
        resource: rawId,
        incomingChatId,
        callbackQueryId: cb.id,
      });
    }
    return;
  }

  // 2. Handle text commands (/start, /menu, /status, /pending, /approve <id> <PIN>, /reject <id> <PIN>)
  if (update.message && update.message.text) {
    const incomingChatId = String(update.message?.chat?.id || "");
    if (!allowedChatIds.has(incomingChatId)) return;

    const text = update.message.text.trim();

    const pendingPin = pendingPinActions.get(incomingChatId);
    if (pendingPin && !text.startsWith("/")) {
      pendingPinActions.delete(incomingChatId);
      if (Date.now() > pendingPin.expiresAt) {
        await sendTelegramMessage(
          "⏱️ Approval PIN prompt expired. Click Approve or Reject again.",
        );
        return;
      }
      if (pendingPin.action === "approve") {
        await handleOwnerApproveAction(pendingPin.txId, {
          messageId: pendingPin.messageId,
          incomingChatId,
          pin: text,
        });
      } else {
        await handleOwnerRejectAction(pendingPin.txId, {
          messageId: pendingPin.messageId,
          incomingChatId,
          pin: text,
        });
      }
      return;
    }

    if (
      text === "/status" ||
      text === "/start" ||
      text === "/menu" ||
      text === "/help"
    ) {
      await sendOwnerControlMenu();
      return;
    }

    if (text === "/pending") {
      await sendPendingApprovalsList();
      return;
    }

    if (text === "/topup_elec") {
      await triggerProactiveTopup({
        resource: "electricity",
        incomingChatId,
      });
      return;
    }

    if (text === "/topup_data") {
      await triggerProactiveTopup({
        resource: "data",
        incomingChatId,
      });
      return;
    }

    const approveMatch = text.match(/^\/approve\s+#?(\d+)(?:\s+(\S+))?$/i);
    if (approveMatch) {
      await handleOwnerApproveAction(approveMatch[1], {
        incomingChatId,
        pin: approveMatch[2] || "",
      });
      return;
    }

    const rejectMatch = text.match(/^\/reject\s+#?(\d+)(?:\s+(\S+))?$/i);
    if (rejectMatch) {
      await handleOwnerRejectAction(rejectMatch[1], {
        incomingChatId,
        pin: rejectMatch[2] || "",
      });
      return;
    }

    // Any other message in Telegram brings up the interactive Owner Control Menu
    await sendOwnerControlMenu();
  }
}

/**
 * Single polling tick (`getUpdates`).
 */
async function pollUpdatesOnce() {
  if (pollInFlight) return;
  const { enabled } = getConfig();
  if (!enabled) return;

  pollInFlight = true;
  try {
    const res = await callTelegramApi("getUpdates", {
      offset: lastUpdateId > 0 ? lastUpdateId + 1 : undefined,
      timeout: 0,
      allowed_updates: ["message", "callback_query"],
    });

    if (res && res.ok && Array.isArray(res.result)) {
      for (const update of res.result) {
        if (
          typeof update.update_id === "number" &&
          update.update_id > lastUpdateId
        ) {
          lastUpdateId = update.update_id;
        }
        // Do not block the poll loop: a slow XRPL payment must not freeze other buttons.
        processUpdate(update).catch((err) => {
          console.error("[Telegram] processUpdate error:", err?.message || err);
        });
      }
    }
  } catch (err) {
    console.error("[Telegram] pollUpdatesOnce error:", err?.message || err);
  } finally {
    pollInFlight = false;
  }
}

/**
 * Registers slash commands in the Telegram Bot menu and sends the initial Owner Control Panel.
 */
async function registerBotMenuAndGreet() {
  try {
    // Ensure no stale webhook is blocking getUpdates polling
    await callTelegramApi("deleteWebhook", { drop_pending_updates: false });
    // Fast-forward past any stale updates queued while the server was stopped
    const initial = await callTelegramApi("getUpdates", {
      offset: -1,
      timeout: 0,
    });
    if (
      initial &&
      initial.ok &&
      Array.isArray(initial.result) &&
      initial.result.length > 0
    ) {
      const latest = initial.result[initial.result.length - 1];
      if (typeof latest.update_id === "number") {
        lastUpdateId = latest.update_id;
      }
    }

    await callTelegramApi("setMyCommands", {
      commands: [
        { command: "menu", description: "Open GridBot Owner Control Panel" },
        { command: "status", description: "Check live meters & daily budget" },
        {
          command: "pending",
          description: "View & approve/reject pending requests",
        },
        {
          command: "topup_elec",
          description: "Buy 5 RLUSD Prepaid Electricity now",
        },
        {
          command: "topup_data",
          description: "Buy 3 RLUSD Emergency LTE Data now",
        },
      ],
    });
    await sendOwnerControlMenu("🟢 *GridBot Online — Owner Control Panel*");
  } catch (_) {}
}

/**
 * 6. initTelegram({ onStateChanged })
 */
function initTelegram({ onStateChanged } = {}) {
  if (typeof onStateChanged === "function") {
    onStateChangedCallback = onStateChanged;
  }

  const { enabled, chatId } = getConfig();
  if (!enabled) {
    console.log(
      "[Telegram] No TELEGRAM_BOT_TOKEN/CHAT_ID configured — Telegram notifications disabled",
    );
    return null;
  }

  if (!pollTimer) {
    registerBotMenuAndGreet().finally(() => {
      if (!pollTimer) {
        pollTimer = setInterval(pollUpdatesOnce, POLL_INTERVAL_MS);
      }
    });
    console.log(`[Telegram] Polling active (every 1s) for chat ID ${chatId}`);
  }

  return { stop: stopTelegram };
}

function stopTelegram() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  initTelegram,
  stopTelegram,
  sendTelegramMessage,
  deleteTelegramMessage,
  getOwnerMenuInlineKeyboard,
  sendOwnerControlMenu,
  notifyLowWarning,
  notifyPendingOwner,
  notifyAutoApproved,
};
