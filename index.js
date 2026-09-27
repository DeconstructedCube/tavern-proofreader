/**
 * Tavern Proofreader - Main Extension Entrypoint
 * Cross-platform writing proofreading, in-line editorial critique & AI guidance
 */

import { computeUnifiedDiff } from './src/diff-engine.js';
import { proofreaderGenerateInterceptor, DEFAULT_SLIDING_WINDOW } from './src/interceptor.js';
import { initSelectionHandler } from './src/selection.js';
import { buildProofreadMessageText, renderProofreadCard, syncHighlightsToTarget } from './src/card-renderer.js';
import { removeHighlightFromNode } from './src/anchor.js';

const MODULE_NAME = 'tavern_proofreader';

// Register global generate interceptor for SillyTavern manifest lookup
globalThis.proofreaderGenerateInterceptor = proofreaderGenerateInterceptor;

// Default extension settings
const defaultSettings = Object.freeze({
  enabled: true,
  slidingWindowSize: DEFAULT_SLIDING_WINDOW,
  autoCollapseOldNotes: false,
});

/**
 * Gets or initializes namespaced extension settings
 */
export function getSettings() {
  const context = SillyTavern.getContext();
  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
      context.extensionSettings[MODULE_NAME][key] = structuredClone(value);
    }
  }
  return context.extensionSettings[MODULE_NAME];
}

/**
 * Updates a setting and saves debounced
 */
export function updateSetting(key, value) {
  const context = SillyTavern.getContext();
  const settings = getSettings();
  settings[key] = value;
  context.saveSettingsDebounced();
}

// Active listener references for paired teardown
let teardownSelection = null;
let boundUserMessageRendered = null;
let boundCharMessageRendered = null;
let boundMessageEdited = null;
let boundMessageSwiped = null;
let boundMessageDeleted = null;
let boundChatChanged = null;

/**
 * Mounts settings UI
 */
async function mountSettingsUI() {
  const context = SillyTavern.getContext();
  try {
    const settings = getSettings();
    const html = await context.renderExtensionTemplateAsync(
      `third-party/${MODULE_NAME}`,
      'settings',
      {
        title: 'Tavern Proofreader 设置',
        enabled: settings.enabled,
        slidingWindowSize: settings.slidingWindowSize,
      }
    );

    $(`#${MODULE_NAME}_settings`).remove();
    $('#extensions_settings2').append(html);

    $(`#${MODULE_NAME}_enable_checkbox`).on('change', function () {
      updateSetting('enabled', $(this).prop('checked'));
    });

    $(`#${MODULE_NAME}_window_input`).on('change', function () {
      const val = parseInt($(this).val(), 10);
      if (!isNaN(val) && val >= 1) {
        updateSetting('slidingWindowSize', val);
      }
    });
  } catch (err) {
    console.error(`[${MODULE_NAME}] Failed to mount settings UI:`, err);
  }
}

/**
 * Handles new proofread submission from the selection editor
 */
export function handleSubmitProofread({ targetMessageIndex, exact, revisedText, instruction, anchor }) {
  const context = SillyTavern.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat) || targetMessageIndex >= chat.length) return;

  const targetMsg = chat[targetMessageIndex];
  if (!targetMsg) return;

  const diffHunk = revisedText && revisedText !== exact ? computeUnifiedDiff(exact, revisedText) : null;
  const entry = {
    id: `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    quoteAnchor: anchor,
    revisedText: revisedText || null,
    diffHunk: diffHunk || null,
    instruction: instruction || null,
    createdAt: Date.now(),
  };

  // Check if an existing proofread note message directly follows the target message (Consolidation)
  const nextMsgIndex = targetMessageIndex + 1;
  const nextMsg = chat[nextMsgIndex];

  if (nextMsg?.extra?.proofreader?.isProofreadNote) {
    // Append to existing note
    nextMsg.extra.proofreader.entries = nextMsg.extra.proofreader.entries || [];
    nextMsg.extra.proofreader.entries.push(entry);
    nextMsg.mes = buildProofreadMessageText(nextMsg.extra.proofreader.entries, targetMessageIndex + 1);

    // Update DOM card
    const noteMesEl = document.querySelector(`.mes[mesid="${nextMsgIndex}"]`);
    if (noteMesEl) {
      renderProofreadCard(noteMesEl, nextMsg, { onRevokeEntry: handleRevokeEntry });
    }
  } else {
    // Create a new note message
    const newNote = {
      name: context.name1 || 'User',
      is_user: true,
      send_date: Date.now(),
      mes: buildProofreadMessageText([entry], targetMessageIndex + 1),
      extra: {
        proofreader: {
          version: 1,
          isProofreadNote: true,
          targetMessageIndex,
          targetSwipeId: targetMsg.swipe_id ?? 0,
          entries: [entry],
          collapsed: false,
        },
      },
    };

    // Splice into chat array directly beneath target message
    chat.splice(nextMsgIndex, 0, newNote);

    // If host has native printMessages or reload
    if (typeof context.printMessages === 'function') {
      context.printMessages();
    } else {
      // Re-scan and render
      setTimeout(() => scanAndRenderAllNotes(), 50);
    }
  }

  context.saveChatDebounced();
  syncHighlightsToTarget(targetMessageIndex, [entry]);
}

/**
 * Handles revoking a single critique entry
 */
export function handleRevokeEntry({ targetMessageIndex, entryId, noteMessage }) {
  const context = SillyTavern.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  const proofreader = noteMessage?.extra?.proofreader;
  if (!proofreader || !Array.isArray(proofreader.entries)) return;

  // Remove target highlight from DOM
  const targetMesEl = document.querySelector(`.mes[mesid="${targetMessageIndex}"] .mes_text`);
  if (targetMesEl) {
    removeHighlightFromNode(targetMesEl, entryId);
  }

  // Filter entry
  proofreader.entries = proofreader.entries.filter((e) => e.id !== entryId);

  const noteIndex = chat.indexOf(noteMessage);
  if (noteIndex === -1) return;

  if (proofreader.entries.length === 0) {
    // Delete the entire note message if empty
    chat.splice(noteIndex, 1);
    const noteMesEl = document.querySelector(`.mes[mesid="${noteIndex}"]`);
    if (noteMesEl) noteMesEl.remove();
  } else {
    // Update message text
    noteMessage.mes = buildProofreadMessageText(proofreader.entries, targetMessageIndex + 1);
    const noteMesEl = document.querySelector(`.mes[mesid="${noteIndex}"]`);
    if (noteMesEl) {
      renderProofreadCard(noteMesEl, noteMessage, { onRevokeEntry: handleRevokeEntry });
    }
  }

  context.saveChatDebounced();
}

/**
 * Full scan and render for all proofread cards and original highlights in DOM
 */
export function scanAndRenderAllNotes() {
  const context = SillyTavern.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  chat.forEach((msg, idx) => {
    if (msg?.extra?.proofreader?.isProofreadNote) {
      const mesEl = document.querySelector(`.mes[mesid="${idx}"]`);
      if (mesEl) {
        renderProofreadCard(mesEl, msg, { onRevokeEntry: handleRevokeEntry });
      }
      // Sync highlights to target
      const targetIdx = msg.extra.proofreader.targetMessageIndex;
      if (typeof targetIdx === 'number' && msg.extra.proofreader.entries) {
        syncHighlightsToTarget(targetIdx, msg.extra.proofreader.entries);
      }
    }
  });
}

/**
 * Register slash commands
 */
function registerSlashCommands() {
  if (typeof SlashCommandParser === 'undefined') return;

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'proofread-status',
      aliases: ['pstatus'],
      helpString: '<div>查看当前批改记录总数：/proofread-status</div>',
      returns: '统计信息',
      callback: () => {
        const context = SillyTavern.getContext();
        const chat = context.chat || [];
        let count = 0;
        chat.forEach((m) => {
          if (m?.extra?.proofreader?.isProofreadNote) {
            count += m.extra.proofreader.entries?.length || 0;
          }
        });
        return `当前共有 ${count} 处修改记录。`;
      },
    })
  );
}

/* ========================================================================= */
/* 生命周期钩子实现                                                          */
/* ========================================================================= */

export async function onActivate() {
  console.log(`[${MODULE_NAME}] Extension activated`);
  registerSlashCommands();
}

export async function onInstall() {
  console.log(`[${MODULE_NAME}] Extension installed`);
}

export function onEnable() {
  console.log(`[${MODULE_NAME}] Extension enabled`);
  const context = SillyTavern.getContext();

  mountSettingsUI();

  // Initialize selection handler
  teardownSelection = initSelectionHandler({
    chatRoot: document.getElementById('chat') || document.body,
    onSubmit: handleSubmitProofread,
  });

  // Paired event listeners
  boundUserMessageRendered = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    if (mesId !== undefined && context.chat?.[mesId]?.extra?.proofreader?.isProofreadNote) {
      const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
      if (mesEl) {
        renderProofreadCard(mesEl, context.chat[mesId], { onRevokeEntry: handleRevokeEntry });
      }
    }
  };

  boundCharMessageRendered = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    if (mesId !== undefined) {
      // Look for note referencing this message
      const nextMsg = context.chat?.[mesId + 1];
      if (nextMsg?.extra?.proofreader?.isProofreadNote) {
        syncHighlightsToTarget(mesId, nextMsg.extra.proofreader.entries || []);
      }
    }
  };

  boundMessageEdited = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    if (mesId !== undefined) {
      const nextMsg = context.chat?.[mesId + 1];
      if (nextMsg?.extra?.proofreader?.isProofreadNote) {
        syncHighlightsToTarget(mesId, nextMsg.extra.proofreader.entries || []);
      }
    }
  };

  boundMessageSwiped = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    if (mesId !== undefined) {
      const currentSwipe = context.chat?.[mesId]?.swipe_id ?? 0;
      const nextMsg = context.chat?.[mesId + 1];
      if (nextMsg?.extra?.proofreader?.isProofreadNote) {
        const isCurrentSwipe = nextMsg.extra.proofreader.targetSwipeId === currentSwipe;
        const noteMesEl = document.querySelector(`.mes[mesid="${mesId + 1}"]`);
        if (noteMesEl) {
          noteMesEl.style.display = isCurrentSwipe ? '' : 'none';
        }
        if (isCurrentSwipe) {
          syncHighlightsToTarget(mesId, nextMsg.extra.proofreader.entries || []);
        } else {
          // Remove highlights for inactive swipe
          const targetMesEl = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
          nextMsg.extra.proofreader.entries?.forEach((entry) => {
            removeHighlightFromNode(targetMesEl, entry.id);
          });
        }
      }
    }
  };

  boundMessageDeleted = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    // Handled natively by index shift or re-render
    setTimeout(() => scanAndRenderAllNotes(), 50);
  };

  boundChatChanged = () => {
    setTimeout(() => scanAndRenderAllNotes(), 100);
  };

  context.eventSource.on(context.event_types.USER_MESSAGE_RENDERED, boundUserMessageRendered);
  context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, boundCharMessageRendered);
  context.eventSource.on(context.event_types.MESSAGE_EDITED, boundMessageEdited);
  context.eventSource.on(context.event_types.MESSAGE_SWIPED, boundMessageSwiped);
  context.eventSource.on(context.event_types.MESSAGE_DELETED, boundMessageDeleted);
  context.eventSource.on(context.event_types.CHAT_CHANGED, boundChatChanged);

  // Initial scan
  scanAndRenderAllNotes();
}

export function onDisable() {
  console.log(`[${MODULE_NAME}] Extension disabled`);
  const context = SillyTavern.getContext();

  if (teardownSelection) {
    teardownSelection();
    teardownSelection = null;
  }

  // Remove all event listeners cleanly
  if (boundUserMessageRendered) {
    context.eventSource.removeListener(context.event_types.USER_MESSAGE_RENDERED, boundUserMessageRendered);
    boundUserMessageRendered = null;
  }
  if (boundCharMessageRendered) {
    context.eventSource.removeListener(context.event_types.CHARACTER_MESSAGE_RENDERED, boundCharMessageRendered);
    boundCharMessageRendered = null;
  }
  if (boundMessageEdited) {
    context.eventSource.removeListener(context.event_types.MESSAGE_EDITED, boundMessageEdited);
    boundMessageEdited = null;
  }
  if (boundMessageSwiped) {
    context.eventSource.removeListener(context.event_types.MESSAGE_SWIPED, boundMessageSwiped);
    boundMessageSwiped = null;
  }
  if (boundMessageDeleted) {
    context.eventSource.removeListener(context.event_types.MESSAGE_DELETED, boundMessageDeleted);
    boundMessageDeleted = null;
  }
  if (boundChatChanged) {
    context.eventSource.removeListener(context.event_types.CHAT_CHANGED, boundChatChanged);
    boundChatChanged = null;
  }

  // Remove UI elements
  $(`#${MODULE_NAME}_settings`).remove();
  $('.tp-selection-toolbar').remove();
  $('.tp-modal-overlay').remove();
}

export async function onClean() {
  console.log(`[${MODULE_NAME}] Cleaning persistent storage`);
  const context = SillyTavern.getContext();
  delete context.extensionSettings[MODULE_NAME];
  context.saveSettingsDebounced();
}
