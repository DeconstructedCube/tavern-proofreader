/**
 * Tavern Proofreader - Main Extension Entrypoint
 * Cross-platform writing proofreading, in-line editorial critique & AI guidance
 */

import { computeUnifiedDiff } from './src/diff-engine.js';
import { proofreaderGenerateInterceptor, DEFAULT_SLIDING_WINDOW } from './src/interceptor.js';
import { initSelectionHandler } from './src/selection.js';
import { buildProofreadMessageText, renderProofreadCard, syncHighlightsToTarget, clearAllHighlights } from './src/card-renderer.js';
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
 * Dynamically resolves current extension folder name from import.meta.url
 * @returns {string}
 */
export function getExtensionFolderName() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      const url = new URL(import.meta.url);
      const parts = url.pathname.split('/').filter(Boolean);
      const thirdPartyIdx = parts.indexOf('third-party');
      if (thirdPartyIdx !== -1 && parts[thirdPartyIdx + 1]) {
        return parts[thirdPartyIdx + 1];
      }
      if (parts.length >= 2) {
        return parts[parts.length - 2];
      }
    }
  } catch {}
  return 'tavern-proofreader';
}

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

/**
 * Injects stylesheet if not already mounted by host
 */
export function ensureStylesheetLoaded() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[href*="tavern-proofreader"], style#tavern-proofreader-style')) {
    return;
  }
  try {
    const link = document.createElement('link');
    link.id = 'tavern-proofreader-style';
    link.rel = 'stylesheet';
    link.href = new URL('style.css', import.meta.url).href;
    document.head.appendChild(link);
  } catch {}
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
 * Mounts settings UI into extension panel
 */
async function mountSettingsUI() {
  if (typeof document === 'undefined') return;
  const context = SillyTavern.getContext();

  try {
    const settings = getSettings();
    const folderName = getExtensionFolderName();
    let html = '';

    // Candidate folders for template resolution
    const candidateFolders = [
      `third-party/${folderName}`,
      'third-party/tavern-proofreader',
      'third-party/tavern_proofreader',
    ];

    for (const folder of candidateFolders) {
      try {
        html = await context.renderExtensionTemplateAsync(
          folder,
          'settings',
          {
            title: '写作批注与批改设置',
            enabled: settings.enabled,
            slidingWindowSize: settings.slidingWindowSize,
          }
        );
        if (html && html.trim()) break;
      } catch {}
    }

    // Fallback: direct relative fetch of settings.html
    if (!html || !html.trim()) {
      try {
        const res = await fetch(new URL('settings.html', import.meta.url));
        if (res.ok) {
          html = await res.text();
          html = html.replace(/\{\{title\}\}/g, '写作批注与批改设置')
                     .replace(/\{\{#if enabled\}\}checked\{\{\/if\}\}/g, settings.enabled ? 'checked' : '')
                     .replace(/\{\{slidingWindowSize\}\}/g, String(settings.slidingWindowSize));
        }
      } catch {}
    }

    if (!html || !html.trim()) return;

    $(`#${MODULE_NAME}_settings`).remove();
    const targetContainer = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    targetContainer.append(html);

    // Bind drawer toggle directly
    $(`#${MODULE_NAME}_settings .inline-drawer-toggle`).off('click').on('click', function () {
      $(this).closest('.inline-drawer').find('.inline-drawer-content').stop().slideToggle(200);
      $(this).find('.inline-drawer-icon').toggleClass('down up');
    });

    $(`#${MODULE_NAME}_enable_checkbox`).off('change').on('change', function () {
      const isChecked = $(this).prop('checked');
      updateSetting('enabled', isChecked);
      if (isChecked) {
        enableExtension();
      } else {
        disableExtension();
      }
    });

    $(`#${MODULE_NAME}_window_input`).off('change').on('change', function () {
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
export async function handleSubmitProofread({ targetMessageIndex, exact, revisedText, instruction, anchor }) {
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

  const nextMsgIndex = targetMessageIndex + 1;
  const nextMsg = chat[nextMsgIndex];

  if (nextMsg?.extra?.proofreader?.isProofreadNote) {
    // Append to existing note
    nextMsg.extra.proofreader.entries = nextMsg.extra.proofreader.entries || [];
    nextMsg.extra.proofreader.entries.push(entry);
    nextMsg.mes = buildProofreadMessageText(nextMsg.extra.proofreader.entries, targetMessageIndex + 1);
  } else {
    // Insert new note message
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
    chat.splice(nextMsgIndex, 0, newNote);
  }

  // Save chat to server
  if (typeof context.saveChatConditional === 'function') {
    await context.saveChatConditional();
  } else if (typeof context.saveChat === 'function') {
    await context.saveChat();
  } else if (typeof context.saveChatDebounced === 'function') {
    context.saveChatDebounced();
  }

  // Reload chat smoothly to ensure DOM matches array indices without wiping regex formats
  if (typeof context.reloadCurrentChat === 'function') {
    await context.reloadCurrentChat();
  } else if (typeof context.printMessages === 'function') {
    await context.printMessages();
  } else {
    scanAndRenderAllNotes();
  }
}

/**
 * Handles revoking a single critique entry
 */
export async function handleRevokeEntry({ targetMessageIndex, entryId, noteMessage }) {
  const context = SillyTavern.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  const proofreader = noteMessage?.extra?.proofreader;
  if (!proofreader || !Array.isArray(proofreader.entries)) return;

  // Filter entry
  proofreader.entries = proofreader.entries.filter((e) => e.id !== entryId);

  const noteIndex = chat.indexOf(noteMessage);
  if (noteIndex === -1) return;

  if (proofreader.entries.length === 0) {
    chat.splice(noteIndex, 1);
  } else {
    noteMessage.mes = buildProofreadMessageText(proofreader.entries, targetMessageIndex + 1);
  }

  if (typeof context.saveChatConditional === 'function') {
    await context.saveChatConditional();
  } else if (typeof context.saveChat === 'function') {
    await context.saveChat();
  } else if (typeof context.saveChatDebounced === 'function') {
    context.saveChatDebounced();
  }

  if (typeof context.reloadCurrentChat === 'function') {
    await context.reloadCurrentChat();
  } else if (typeof context.printMessages === 'function') {
    await context.printMessages();
  } else {
    scanAndRenderAllNotes();
  }
}

/**
 * Full scan and render for all proofread cards and original highlights in DOM
 */
export function scanAndRenderAllNotes() {
  if (typeof document === 'undefined') return;
  const context = SillyTavern.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  // Clear orphaned highlights first
  clearAllHighlights();

  chat.forEach((msg, idx) => {
    if (msg?.extra?.proofreader?.isProofreadNote) {
      const mesEl = document.querySelector(`.mes[mesid="${idx}"]`);
      if (mesEl && mesEl.getAttribute('is_user') === 'true') {
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

/**
 * Enables and starts all extension subsystems
 */
export function enableExtension() {
  if (teardownSelection) return;

  ensureStylesheetLoaded();
  mountSettingsUI();

  teardownSelection = initSelectionHandler({
    chatRoot: (typeof document !== 'undefined' ? (document.getElementById('chat') || document.body) : null),
    onSubmit: handleSubmitProofread,
  });

  const context = SillyTavern.getContext();

  boundUserMessageRendered = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    if (mesId !== undefined && context.chat?.[mesId]?.extra?.proofreader?.isProofreadNote) {
      const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
      if (mesEl && mesEl.getAttribute('is_user') === 'true') {
        renderProofreadCard(mesEl, context.chat[mesId], { onRevokeEntry: handleRevokeEntry });
      }
    }
  };

  boundCharMessageRendered = (data) => {
    const mesId = typeof data === 'number' ? data : data?.mesId;
    if (mesId !== undefined) {
      const nextMsg = context.chat?.[mesId + 1];
      if (nextMsg?.extra?.proofreader?.isProofreadNote) {
        syncHighlightsToTarget(mesId, nextMsg.extra.proofreader.entries || []);
      }
    }
  };

  boundMessageEdited = (data) => {
    setTimeout(() => scanAndRenderAllNotes(), 50);
  };

  boundMessageSwiped = (data) => {
    setTimeout(() => scanAndRenderAllNotes(), 50);
  };

  boundMessageDeleted = (data) => {
    setTimeout(() => scanAndRenderAllNotes(), 50);
  };

  boundChatChanged = () => {
    setTimeout(() => scanAndRenderAllNotes(), 80);
  };

  context.eventSource.on(context.event_types.USER_MESSAGE_RENDERED, boundUserMessageRendered);
  context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, boundCharMessageRendered);
  context.eventSource.on(context.event_types.MESSAGE_EDITED, boundMessageEdited);
  context.eventSource.on(context.event_types.MESSAGE_SWIPED, boundMessageSwiped);
  context.eventSource.on(context.event_types.MESSAGE_DELETED, boundMessageDeleted);
  context.eventSource.on(context.event_types.CHAT_CHANGED, boundChatChanged);

  scanAndRenderAllNotes();
}

/**
 * Disables and tears down all extension subsystems
 */
export function disableExtension() {
  const context = SillyTavern.getContext();

  if (teardownSelection) {
    teardownSelection();
    teardownSelection = null;
  }

  clearAllHighlights();

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

  if (typeof $ !== 'undefined') {
    $(`#${MODULE_NAME}_settings`).remove();
    $('.tp-selection-toolbar').remove();
    $('.tp-modal-overlay').remove();
  }
}

/* ========================================================================= */
/* 生命周期钩子实现                                                          */
/* ========================================================================= */

export async function onActivate() {
  console.log(`[${MODULE_NAME}] Extension activated`);
  registerSlashCommands();

  const settings = getSettings();
  if (settings.enabled !== false) {
    enableExtension();
  }
}

export async function onInstall() {
  console.log(`[${MODULE_NAME}] Extension installed`);
}

export function onEnable() {
  console.log(`[${MODULE_NAME}] Extension enabled`);
  updateSetting('enabled', true);
  enableExtension();
}

export function onDisable() {
  console.log(`[${MODULE_NAME}] Extension disabled`);
  updateSetting('enabled', false);
  disableExtension();
}

export async function onClean() {
  console.log(`[${MODULE_NAME}] Cleaning persistent storage`);
  const context = SillyTavern.getContext();
  delete context.extensionSettings[MODULE_NAME];
  context.saveSettingsDebounced();
}

// Auto-run on DOM ready for seamless instant start upon import or reload
if (typeof jQuery !== 'undefined') {
  jQuery(async () => {
    try {
      const settings = getSettings();
      if (settings.enabled !== false) {
        enableExtension();
      }
    } catch (err) {
      console.warn(`[${MODULE_NAME}] Auto-start deferred to host lifecycle`);
    }
  });
}
