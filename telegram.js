// telegram.js
// Telegram Owner Notification & Multisig Override Bot for GridBot.
// Uses node-telegram-bot-api (TELEGRAM_BOT_TOKEN and OWNER_CHAT_ID in .env).
//
// Features:
// 1. When a transaction becomes pending_owner, sends a message to OWNER_CHAT_ID with
//    resource, amount, reason, remaining daily budget, and inline buttons [Approve] [Reject].
// 2. [Approve] -> calls ownerApprove(id) (signs with Owner Key weight 2), vends the resource,
//    and replies with the XRPL Testnet explorer link (plus keypad token if electricity).
// 3. [Reject] -> updates row to status 'blocked' with blocked_reason 'rejected by owner'.
// 4. When a payment succeeds automatically (auto_approved), sends a short notification,
//    including "Enter on meter: XXXX XXXX XXXX XXXX XXXX" for electricity.
// 5. Strictly responds ONLY to OWNER_CHAT_ID.

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { getPolicy, spentToday, getTx, updateTx } = require('./db');
const { ownerApprove } = require('./policy-signer');
const { getResource } = require('./resources');

const XRPL_EXPLORER_BASE =
  process.env.XRPL_EXPLORER_BASE || 'https://testnet.xrpl.org/transactions';

function explorerUrl(txHash) {
  if (!txHash) return null;
  return `${XRPL_EXPLORER_BASE.replace(/\/$/, '')}/${txHash}`;
}

function getBotConfig() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const ownerChatId = (
    process.env.OWNER_CHAT_ID ||
    process.env.TELEGRAM_CHAT_ID ||
    ''
  ).trim();
  return { token, ownerChatId };
}

let bot = null;
let onStateChangedCallback = null;

/**
 * Checks whether an incoming Telegram message or callback query is from OWNER_CHAT_ID.
 */
function isAuthorizedOwner(chatId) {
  const { ownerChatId } = getBotConfig();
  if (!ownerChatId) return false;
  return String(chatId) === String(ownerChatId);
}

/**
 * Initializes the Telegram bot (polling mode) if TELEGRAM_BOT_TOKEN is configured.
 * @param {object} [options]
 * @param {Function} [options.onStateChanged] - Callback invoked after Approve/Reject so server.js can broadcast WS updates
 */
function initTelegram({ onStateChanged } = {}) {
  if (typeof onStateChanged === 'function') {
    onStateChangedCallback = onStateChanged;
  }

  const { token, ownerChatId } = getBotConfig();
  if (!token) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN not set in .env — Telegram notifications disabled.');
    return null;
  }

  if (bot) {
    return bot;
  }

  bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (err) => {
    console.warn('[Telegram Polling Warning]:', err.message || err);
  });

  // Helper command so owner can check their chat ID or status if needed, but ONLY responds to OWNER_CHAT_ID
  bot.on('message', async (msg) => {
    const chatId = msg?.chat?.id;
    if (!isAuthorizedOwner(chatId)) {
      return; // Strictly ignore any chat other than OWNER_CHAT_ID
    }

    const text = (msg.text || '').trim();
    if (text === '/start' || text === '/status') {
      try {
        const policy = await getPolicy();
        const spent = await spentToday();
        const remaining = Math.max(0, Math.round((Number(policy.daily_cap) - spent) * 1e6) / 1e6);
        await bot.sendMessage(
          chatId,
          `⚡ *GridBot AI CFO Connected*\n` +
            `• Spent Today: ${spent} RLUSD\n` +
            `• Remaining Daily Budget: ${remaining} RLUSD (Cap: ${policy.daily_cap} RLUSD)\n` +
            `• Per-Tx Cap: ${policy.per_tx_cap} RLUSD`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await bot.sendMessage(chatId, `GridBot error: ${err.message}`);
      }
    }
  });

  // Handle inline button clicks: approve:<id> or reject:<id>
  bot.on('callback_query', async (query) => {
    const chatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;

    // Strictly respond ONLY to OWNER_CHAT_ID
    if (!isAuthorizedOwner(chatId)) {
      try {
        await bot.answerCallbackQuery(query.id, {
          text: 'Unauthorized: Only OWNER_CHAT_ID can approve or reject.',
          show_alert: true,
        });
      } catch {}
      return;
    }

    const data = query.data || '';
    const [action, rawId] = data.split(':');
    const txId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;

    if (!txId || (action !== 'approve' && action !== 'reject')) {
      await bot.answerCallbackQuery(query.id, { text: 'Invalid action' });
      return;
    }

    try {
      const txRow = await getTx(txId);
      if (txRow.status !== 'pending_owner') {
        await bot.answerCallbackQuery(query.id, {
          text: `Already processed (${txRow.status})`,
        });
        return;
      }

      if (action === 'approve') {
        await bot.answerCallbackQuery(query.id, {
          text: 'Signing with Owner Key (weight 2) on XRPL Testnet...',
        });

        const approveRes = await ownerApprove(txId);

        if (approveRes.status === 'owner_approved') {
          let vendResult = null;
          try {
            const plugin = getResource(txRow.resource);
            vendResult = plugin.vend(txRow.amount);
          } catch (vendErr) {
            console.warn('[Telegram] Vend after ownerApprove warning:', vendErr.message);
          }

          const link = explorerUrl(approveRes.txHash);
          let replyLines = [
            `✅ *Owner Approved (#${txId})*`,
            `• Resource: ${txRow.resource}`,
            `• Amount: ${txRow.amount} RLUSD`,
            `• Explorer: ${link}`,
          ];

          if (vendResult?.token) {
            replyLines.push(`• Enter on meter: \`${vendResult.token}\``);
          } else if (vendResult?.bundle) {
            replyLines.push(`• Vended: ${vendResult.bundle}`);
          }

          // Remove inline buttons on original prompt so it can't be clicked twice
          if (messageId) {
            try {
              await bot.editMessageReplyMarkup(
                { inline_keyboard: [] },
                { chat_id: chatId, message_id: messageId }
              );
            } catch {}
          }

          await bot.sendMessage(chatId, replyLines.join('\n'), {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          });

          if (onStateChangedCallback) {
            await onStateChangedCallback({
              type: 'owner_approved',
              txId,
              approveResult: approveRes,
              vend: vendResult,
            });
          }
        } else {
          await bot.sendMessage(
            chatId,
            `❌ Owner approval failed for #${txId}: ${approveRes.reason || 'Unknown error'}`
          );
          if (onStateChangedCallback) {
            await onStateChangedCallback({ type: 'error', txId });
          }
        }
      } else if (action === 'reject') {
        const updated = await updateTx(txId, {
          status: 'blocked',
          blocked_reason: 'rejected by owner',
        });

        await bot.answerCallbackQuery(query.id, {
          text: 'Transaction rejected and marked blocked.',
        });

        if (messageId) {
          try {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: chatId, message_id: messageId }
            );
          } catch {}
        }

        await bot.sendMessage(
          chatId,
          `🚫 *Rejected (#${txId})*\nMarked as \`blocked\` (reason: "rejected by owner").`,
          { parse_mode: 'Markdown' }
        );

        if (onStateChangedCallback) {
          await onStateChangedCallback({
            type: 'owner_rejected',
            txId,
            transaction: updated,
          });
        }
      }
    } catch (err) {
      console.error('[Telegram callback_query error]:', err.message);
      try {
        await bot.sendMessage(chatId, `⚠️ Error processing #${txId}: ${err.message}`);
      } catch {}
    }
  });

  console.log(
    `[Telegram] Bot active. Authorized OWNER_CHAT_ID: ${ownerChatId || '(not set yet)'}`
  );
  return bot;
}

/**
 * Sends a notification to OWNER_CHAT_ID when a transaction becomes pending_owner,
 * with inline buttons [Approve] [Reject].
 */
async function notifyPendingOwner({ id, resource, amount, reason, blockedReason, remainingBudget }) {
  const { ownerChatId } = getBotConfig();
  if (!bot || !ownerChatId) return;

  try {
    let rem = remainingBudget;
    if (rem === undefined) {
      const policy = await getPolicy();
      const spent = await spentToday();
      rem = Math.max(0, Math.round((Number(policy.daily_cap) - spent) * 1e6) / 1e6);
    }

    const lines = [
      `⚠️ *Owner Signature Needed (Tx #${id})*`,
      `• *Resource:* ${resource}`,
      `• *Amount:* ${amount} RLUSD`,
      `• *Reason:* ${reason || 'Low balance top-up'}`,
      blockedReason ? `• *Policy Cap Note:* ${blockedReason}` : null,
      `• *Remaining Daily Budget:* ${rem} RLUSD`,
    ].filter(Boolean);

    await bot.sendMessage(ownerChatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${id}` },
            { text: 'Reject', callback_data: `reject:${id}` },
          ],
        ],
      },
    });
  } catch (err) {
    console.error('[Telegram notifyPendingOwner] Error:', err.message);
  }
}

/**
 * Sends a short notification to OWNER_CHAT_ID when a payment succeeds automatically.
 * Includes the 20-digit STS token formatted for keypad entry ("Enter on meter: ...") for electricity.
 */
async function notifyAutoApproved({ resource, amount, reason, txHash, vend }) {
  const { ownerChatId } = getBotConfig();
  if (!bot || !ownerChatId) return;

  try {
    const link = explorerUrl(txHash);
    const lines = [
      `⚡ *GridBot Auto-Payment Confirmed*`,
      `• *Resource:* ${resource} (${amount} RLUSD)`,
      reason ? `• *Reason:* ${reason}` : null,
    ].filter(Boolean);

    if (resource === 'electricity' && vend?.token) {
      lines.push(`• *Enter on meter:* \`${vend.token}\``);
    } else if (vend?.bundle) {
      lines.push(`• *Bundle activated:* ${vend.bundle}`);
    }

    if (link) {
      lines.push(`• [View on XRPL Testnet](${link})`);
    }

    await bot.sendMessage(ownerChatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[Telegram notifyAutoApproved] Error:', err.message);
  }
}

module.exports = {
  initTelegram,
  notifyPendingOwner,
  notifyAutoApproved,
};
