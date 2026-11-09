// telegram.js
// Telegram Owner NotificationBot for GridBot Main App.
// Uses policy-client.js to read state from the isolated Policy Service.

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const {
  getState,
  getTx,
  proxyOwnerApprove,
  proxyOwnerReject,
} = require('./policy-client');
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

function isAuthorizedOwner(chatId) {
  const { ownerChatId } = getBotConfig();
  if (!ownerChatId) return false;
  return String(chatId) === String(ownerChatId);
}

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
    const msg = String(err?.message || err || '');
    if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
      // Transient idle socket reset or brief network drop; node-telegram-bot-api automatically retries on the next poll
      return;
    }
    console.warn('[Telegram Polling Warning]:', msg);
  });

  bot.on('message', async (msg) => {
    const chatId = msg?.chat?.id;
    if (!isAuthorizedOwner(chatId)) {
      return;
    }

    const text = (msg.text || '').trim();
    if (text === '/start' || text === '/status') {
      try {
        const state = await getState();
        const policy = state.policy;
        const spent = Number(state.spentToday || 0);
        const remaining = Number(state.budgetRemaining || 0);
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

  bot.on('callback_query', async (query) => {
    const chatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;

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

      const passcode = (process.env.OWNER_PASSCODE || '').trim();

      if (action === 'approve') {
        await bot.answerCallbackQuery(query.id, {
          text: 'Requesting Policy Service owner approval...',
        });

        const { ok, data: approveRes } = await proxyOwnerApprove(txId, passcode);

        if (ok && approveRes.status === 'owner_approved') {
          let vendResult = null;
          try {
            const plugin = getResource(txRow.resource);
            vendResult = plugin.vend(txRow.amount);
          } catch (vendErr) {
            console.warn('[Telegram] Vend after ownerApprove warning:', vendErr.message);
          }

          const link = explorerUrl(approveRes.txHash);
          const replyLines = [
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
            `❌ Owner approval failed for #${txId}: ${
              approveRes?.error || approveRes?.reason || 'Requires owner passcode on dashboard'
            }`
          );
        }
      } else if (action === 'reject') {
        const { ok, data: rejectRes } = await proxyOwnerReject(txId, passcode);
        if (ok) {
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
              transaction: rejectRes.transaction,
            });
          }
        } else {
          await bot.sendMessage(
            chatId,
            `❌ Reject failed for #${txId}: ${rejectRes?.error || 'Requires owner passcode'}`
          );
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

async function notifyPendingOwner({ id, resource, amount, reason, blockedReason, remainingBudget }) {
  const { ownerChatId } = getBotConfig();
  if (!bot || !ownerChatId) return;

  try {
    let rem = remainingBudget;
    if (rem === undefined) {
      const state = await getState();
      rem = Number(state.budgetRemaining || 0);
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
