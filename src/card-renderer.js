/**
 * Tavern Proofreader - Minimalist Card Renderer & Highlight Synchronizer
 * Converts user proofreading messages into elegant note cards and applies highlights to original text
 */

import { findAnchorPosition, applyHighlightToNode, removeHighlightFromNode } from './anchor.js';

/**
 * Escapes HTML characters safely
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Builds the standard physical markdown text for `msg.mes`
 * @param {Array<object>} entries
 * @param {number} targetTurn 1-based turn number
 * @returns {string}
 */
export function buildProofreadMessageText(entries, targetTurn) {
  const lines = [
    `【正文批改与修润建议】`,
    `针对第 ${targetTurn} 楼正文提出以下修改意见：`,
    '',
  ];

  entries.forEach((entry, idx) => {
    lines.push(`### 条目 [${idx + 1}]`);
    if (entry.diffHunk) {
      lines.push('```diff');
      lines.push(entry.diffHunk);
      lines.push('```');
    } else if (entry.quoteAnchor?.exact) {
      lines.push(`> 引用原文：「${entry.quoteAnchor.exact}」`);
    }

    if (entry.instruction) {
      lines.push(`> 指导意见：${entry.instruction}`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('【写作指导】：请在后续剧情推进中参考上述修改标准，遵循设定继续撰写，无需复述历史修改内容，亦不必对此批改做专门解释。');
  return lines.join('\n');
}

/**
 * Renders diff lines with color-coded syntax spans
 * @param {string} diffHunk
 * @returns {string} HTML string
 */
export function formatDiffHtml(diffHunk) {
  if (!diffHunk) return '';
  const lines = diffHunk.split('\n');
  const rendered = lines.map((line) => {
    const escaped = escapeHtml(line);
    if (line.startsWith('@@')) {
      return `<span class="tp-diff-hunk">${escaped}</span>`;
    }
    if (line.startsWith('+')) {
      return `<span class="tp-diff-add">${escaped}</span>`;
    }
    if (line.startsWith('-')) {
      return `<span class="tp-diff-del">${escaped}</span>`;
    }
    return `<span class="tp-diff-context">${escaped}</span>`;
  });
  return `<pre class="tp-diff-block"><code>${rendered.join('\n')}</code></pre>`;
}

/**
 * Applies highlights to the target original message in DOM
 * @param {number} targetMessageIndex
 * @param {Array<object>} entries
 */
export function syncHighlightsToTarget(targetMessageIndex, entries) {
  const targetMesEl = document.querySelector(`.mes[mesid="${targetMessageIndex}"]`);
  if (!targetMesEl) return;

  const mesTextEl = targetMesEl.querySelector('.mes_text');
  if (!mesTextEl) return;

  const fullText = mesTextEl.textContent || '';

  entries.forEach((entry) => {
    const match = findAnchorPosition(fullText, entry.quoteAnchor);
    if (match) {
      const mark = applyHighlightToNode(mesTextEl, entry.id, match.start, match.end);
      if (mark) {
        mark.onclick = (e) => {
          e.stopPropagation();
          highlightAndScrollToNote(targetMessageIndex);
        };
      }
    }
  });
}

/**
 * Smoothly scrolls to the proofreading note card
 * @param {number} targetMessageIndex
 */
export function highlightAndScrollToNote(targetMessageIndex) {
  const noteMesEl = document.querySelector(`.mes.tp-proofread-card-mes[data-target-index="${targetMessageIndex}"]`);
  if (noteMesEl) {
    noteMesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    noteMesEl.classList.add('tp-pulse-focus');
    setTimeout(() => noteMesEl.classList.remove('tp-pulse-focus'), 1200);
  }
}

/**
 * Smoothly scrolls to the original text highlight
 * @param {number} targetMessageIndex
 * @param {string} entryId
 */
export function scrollToOriginalHighlight(targetMessageIndex, entryId) {
  const targetMesEl = document.querySelector(`.mes[mesid="${targetMessageIndex}"]`);
  if (!targetMesEl) return;

  const mark = targetMesEl.querySelector(`mark.tp-highlight[data-entry-id="${entryId}"]`);
  if (mark) {
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('tp-pulse-focus');
    setTimeout(() => mark.classList.remove('tp-pulse-focus'), 1200);
  } else {
    targetMesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Renders the custom proofreader card into the DOM element of a note message
 * @param {HTMLElement} mesEl The message DOM element
 * @param {object} message The message data object
 * @param {object} callbacks { onRevokeEntry, onToggleCollapse }
 */
export function renderProofreadCard(mesEl, message, { onRevokeEntry }) {
  const proofreader = message?.extra?.proofreader;
  if (!proofreader || !proofreader.isProofreadNote) return;

  const targetIndex = proofreader.targetMessageIndex;
  const targetTurn = targetIndex + 1;
  const entries = proofreader.entries || [];

  mesEl.classList.add('tp-proofread-card-mes');
  mesEl.setAttribute('data-target-index', String(targetIndex));

  const mesTextEl = mesEl.querySelector('.mes_text');
  if (!mesTextEl) return;

  // Build card HTML
  const isCollapsed = Boolean(proofreader.collapsed);
  const entriesHtml = entries.map((entry, idx) => {
    return `
      <div class="tp-entry-item" data-entry-id="${entry.id}">
        <div class="tp-entry-header">
          <span class="tp-entry-badge">修改 [${idx + 1}]</span>
          <div class="tp-entry-actions">
            <button type="button" class="tp-action-btn tp-scroll-btn" title="查看对应原句">查看原文</button>
            <button type="button" class="tp-action-btn tp-revoke-btn" title="删除此条修改">删除</button>
          </div>
        </div>

        ${entry.diffHunk ? formatDiffHtml(entry.diffHunk) : ''}
        ${!entry.diffHunk && entry.quoteAnchor?.exact ? `<blockquote class="tp-quote-block">引用：「${escapeHtml(entry.quoteAnchor.exact)}」</blockquote>` : ''}

        ${entry.instruction ? `<div class="tp-instruction-block"><span class="tp-inst-label">指导意见：</span>${escapeHtml(entry.instruction)}</div>` : ''}
      </div>
    `;
  }).join('');

  mesTextEl.innerHTML = `
    <div class="tp-card-container ${isCollapsed ? 'tp-collapsed' : ''}">
      <div class="tp-card-header">
        <div class="tp-card-title">
          <span class="tp-icon">📝</span>
          <span class="tp-title-text">批注便签 · 第 ${targetTurn} 楼</span>
          <span class="tp-count-badge">${entries.length} 处修改</span>
        </div>
        <button type="button" class="tp-collapse-btn" title="折叠/展开便签">
          ${isCollapsed ? '展开 ▼' : '折叠 ▲'}
        </button>
      </div>

      <div class="tp-card-body" style="${isCollapsed ? 'display: none;' : ''}">
        ${entriesHtml}
      </div>
    </div>
  `;

  // Bind Collapse Toggle
  const collapseBtn = mesTextEl.querySelector('.tp-collapse-btn');
  const cardBody = mesTextEl.querySelector('.tp-card-body');
  const container = mesTextEl.querySelector('.tp-card-container');

  collapseBtn.onclick = (e) => {
    e.stopPropagation();
    proofreader.collapsed = !proofreader.collapsed;
    if (proofreader.collapsed) {
      cardBody.style.display = 'none';
      collapseBtn.textContent = '展开 ▼';
      container.classList.add('tp-collapsed');
    } else {
      cardBody.style.display = 'block';
      collapseBtn.textContent = '折叠 ▲';
      container.classList.remove('tp-collapsed');
    }
  };

  // Bind Entry Actions
  mesTextEl.querySelectorAll('.tp-entry-item').forEach((itemEl) => {
    const entryId = itemEl.getAttribute('data-entry-id');
    const scrollBtn = itemEl.querySelector('.tp-scroll-btn');
    const revokeBtn = itemEl.querySelector('.tp-revoke-btn');

    if (scrollBtn) {
      scrollBtn.onclick = (e) => {
        e.stopPropagation();
        scrollToOriginalHighlight(targetIndex, entryId);
      };
    }

    if (revokeBtn) {
      revokeBtn.onclick = (e) => {
        e.stopPropagation();
        onRevokeEntry({ targetMessageIndex: targetIndex, entryId, noteMessage: message });
      };
    }
  });

  // Sync highlights onto target message in DOM
  syncHighlightsToTarget(targetIndex, entries);
}
