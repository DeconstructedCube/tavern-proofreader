/**
 * Tavern Proofreader - Multi-platform Selection Toolbar & In-place Editor
 * Handles floating trigger capsules and responsive edit modals across PC and Mobile
 */

import { createAnchorFromRange } from './anchor.js';

let currentSelectionState = null;
let activeTriggerEl = null;
let activeModalEl = null;

/**
 * Extracts the current selection state from window.getSelection()
 * @returns {object|null}
 */
export function getLiveSelectionState() {
  if (typeof window === 'undefined') return null;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const selectedText = range.toString().trim();
  if (selectedText.length === 0) {
    return null;
  }

  // Locate the containing message element
  const container = range.commonAncestorContainer;
  const mesTextEl = container.nodeType === Node.ELEMENT_NODE
    ? container.closest('.mes_text')
    : container.parentElement?.closest('.mes_text');

  if (!mesTextEl) return null;

  // Locate outer message card
  const mesEl = mesTextEl.closest('.mes, div[mesid]');
  if (!mesEl) return null;

  // Verify it's an AI message (not user, not system)
  const isUserAttr = mesEl.getAttribute('is_user');
  const isUserClass = mesEl.classList.contains('is_user');
  const isSystemAttr = mesEl.getAttribute('is_system');
  if (isUserAttr === 'true' || isUserClass || isSystemAttr === 'true') {
    return null;
  }

  // Determine message index
  const mesIdAttr = mesEl.getAttribute('mesid');
  const targetMessageIndex = mesIdAttr !== null ? parseInt(mesIdAttr, 10) : null;
  if (targetMessageIndex === null || isNaN(targetMessageIndex)) {
    return null;
  }

  // Capture anchor data safely
  const anchor = createAnchorFromRange(range, mesTextEl);

  return {
    targetMessageIndex,
    mesTextEl,
    exact: selectedText,
    anchor,
    rect: range.getBoundingClientRect(),
  };
}

/**
 * Initializes selection and touch listeners on the chat container
 * @param {object} options
 * @param {HTMLElement} [options.chatRoot]
 * @param {Function} options.onSubmit Callback when user submits a critique
 * @returns {Function} Teardown function to unbind all listeners
 */
export function initSelectionHandler({ chatRoot = document.body, onSubmit }) {
  const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

  function dismissTrigger() {
    if (activeTriggerEl) {
      activeTriggerEl.remove();
      activeTriggerEl = null;
    }
  }

  function dismissModal() {
    if (activeModalEl) {
      activeModalEl.remove();
      activeModalEl = null;
    }
    currentSelectionState = null;
  }

  function handleSelection() {
    // If modal is currently open, don't show floating trigger
    if (activeModalEl) return;

    const liveState = getLiveSelectionState();
    if (!liveState) {
      dismissTrigger();
      return;
    }

    currentSelectionState = liveState;

    renderTriggerToolbar(currentSelectionState, isTouchDevice, () => {
      // Re-read live selection at moment of opening to guarantee latest dragged range
      const freshState = getLiveSelectionState() || currentSelectionState;
      openInPlaceEditor(freshState, onSubmit, dismissModal);
    });
  }

  function renderTriggerToolbar(state, isTouch, onOpenEditor) {
    if (activeTriggerEl) {
      // Update existing button text and count without recreating DOM
      const btn = activeTriggerEl.querySelector('.tp-trigger-btn');
      if (btn) {
        btn.innerHTML = `<span class="tp-icon">✍</span> 批改选中文本 <small>(${state.exact.length}字)</small>`;
      }
      return;
    }

    const trigger = document.createElement('div');
    trigger.className = 'tp-selection-toolbar' + (isTouch ? ' tp-mobile' : ' tp-desktop');
    trigger.setAttribute('data-tt-mobile-surface', 'free-window');

    // Prevent mousedown/touchstart from collapsing selection prematurely
    trigger.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    trigger.addEventListener('touchstart', (e) => {
      e.stopPropagation();
    }, { passive: true });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tp-trigger-btn';
    btn.innerHTML = `<span class="tp-icon">✍</span> 批改选中文本 <small>(${state.exact.length}字)</small>`;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissTrigger();
      onOpenEditor();
    });

    trigger.appendChild(btn);
    document.body.appendChild(trigger);
    activeTriggerEl = trigger;

    // Viewport-based positioning
    trigger.style.position = 'fixed';
    trigger.style.zIndex = '99999';

    if (!isTouch && state.rect) {
      const top = state.rect.top > 52 ? state.rect.top - 46 : state.rect.bottom + 8;
      const left = Math.max(10, Math.min(window.innerWidth - 180, state.rect.left + state.rect.width / 2 - 80));
      trigger.style.top = `${top}px`;
      trigger.style.left = `${left}px`;
    } else {
      // Bottom safe-area bar on mobile
      trigger.style.bottom = 'calc(env(safe-area-inset-bottom, 16px) + 20px)';
      trigger.style.left = '50%';
      trigger.style.transform = 'translateX(-50%)';
    }
  }

  // Event listeners: debounce handleSelection for smooth dragging handle tracking
  let selectionTimeout = null;
  const debouncedHandleSelection = (delay = 40) => {
    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(handleSelection, delay);
  };

  const onMouseUp = () => debouncedHandleSelection(30);
  const onTouchEnd = () => debouncedHandleSelection(50);
  const onSelectionChange = () => {
    // Dynamically track selection expansions/collapses
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      dismissTrigger();
    } else {
      debouncedHandleSelection(60);
    }
  };

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchend', onTouchEnd);
  document.addEventListener('selectionchange', onSelectionChange);

  return function cleanup() {
    clearTimeout(selectionTimeout);
    dismissTrigger();
    dismissModal();
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('selectionchange', onSelectionChange);
  };
}

/**
 * Opens the in-place text editor modal / bottom sheet
 * @param {object} state
 * @param {Function} onSubmit
 * @param {Function} onDismiss
 */
function openInPlaceEditor(state, onSubmit, onDismiss) {
  if (!state || !state.exact) return;

  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'tp-modal-overlay';
  modalOverlay.setAttribute('data-tt-mobile-surface', 'backdrop');

  const card = document.createElement('div');
  card.className = 'tp-editor-card';
  card.setAttribute('data-tt-mobile-surface', 'fullscreen-window');

  card.innerHTML = `
    <div class="tp-editor-header">
      <div class="tp-editor-title">
        <span class="tp-icon">✍</span> 文本修改与批注
        <span class="tp-turn-badge">第 ${state.targetMessageIndex + 1} 楼</span>
      </div>
      <button type="button" class="tp-close-btn" title="关闭">✕</button>
    </div>

    <div class="tp-editor-body">
      <div class="tp-field-group">
        <div class="tp-field-label-row">
          <label class="tp-field-label">修改建议 (直接修改文字即可生成对照)：</label>
          <button type="button" class="tp-reset-btn" title="还原为划选原句">重置</button>
        </div>
        <textarea class="tp-revised-input" rows="3"></textarea>
        <div class="tp-mode-indicator tp-mode-pure">未改动文字 (仅提交批注意见)</div>
      </div>

      <div class="tp-field-group">
        <label class="tp-field-label">指导意见 (可选)：</label>
        <textarea class="tp-instruction-input" rows="2" placeholder="例如：补充神态细节，放缓叙事节奏..."></textarea>
      </div>
    </div>

    <div class="tp-editor-footer">
      <button type="button" class="tp-btn tp-btn-secondary tp-cancel-btn">取消</button>
      <button type="button" class="tp-btn tp-btn-primary tp-submit-btn">保存批改</button>
    </div>
  `;

  modalOverlay.appendChild(card);
  document.body.appendChild(modalOverlay);
  activeModalEl = modalOverlay;

  const revisedInput = card.querySelector('.tp-revised-input');
  const instructionInput = card.querySelector('.tp-instruction-input');
  const modeIndicator = card.querySelector('.tp-mode-indicator');
  const resetBtn = card.querySelector('.tp-reset-btn');
  const closeBtn = card.querySelector('.tp-close-btn');
  const cancelBtn = card.querySelector('.tp-cancel-btn');
  const submitBtn = card.querySelector('.tp-submit-btn');

  // Prefill with original exact text
  revisedInput.value = state.exact;
  revisedInput.focus();
  revisedInput.setSelectionRange(state.exact.length, state.exact.length);

  function updateModeIndicator() {
    const isChanged = revisedInput.value.trim() !== state.exact.trim();
    if (isChanged) {
      modeIndicator.className = 'tp-mode-indicator tp-mode-diff';
      modeIndicator.textContent = '已修改文字 (将生成修改对照)';
    } else {
      modeIndicator.className = 'tp-mode-indicator tp-mode-pure';
      modeIndicator.textContent = '未改动文字 (仅提交批注意见)';
    }
  }

  revisedInput.addEventListener('input', updateModeIndicator);

  resetBtn.addEventListener('click', () => {
    revisedInput.value = state.exact;
    updateModeIndicator();
    revisedInput.focus();
  });

  const close = () => {
    modalOverlay.remove();
    activeModalEl = null;
    onDismiss();
  };

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) close();
  });

  submitBtn.addEventListener('click', () => {
    const revisedText = revisedInput.value.trim();
    const instruction = instructionInput.value.trim();

    onSubmit({
      targetMessageIndex: state.targetMessageIndex,
      exact: state.exact,
      revisedText: revisedText !== state.exact ? revisedText : null,
      instruction: instruction || null,
      anchor: state.anchor,
    });
    close();
  });
}
