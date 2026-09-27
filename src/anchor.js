/**
 * Tavern Proofreader - W3C TextQuoteSelector & Fuzzy Re-anchoring Engine
 * Safe text node splitting without breaking custom HTML, regex frontends or iframes
 */

/**
 * Calculates Levenshtein distance between two strings
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const m = a.length;
  const n = b.length;
  let prevRow = Array.from({ length: n + 1 }, (_, i) => i);
  let currRow = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,       // Insertion
        prevRow[j] + 1,           // Deletion
        prevRow[j - 1] + cost     // Substitution
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[n];
}

/**
 * Computes string similarity score (0 to 1)
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function stringSimilarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

/**
 * Creates a W3C TextQuoteSelector anchor from a DOM Range inside a container
 * @param {Range} range
 * @param {HTMLElement} rootContainer
 * @param {number} [contextLength=25]
 * @returns {{ exact: string, prefix: string, suffix: string }}
 */
export function createAnchorFromRange(range, rootContainer, contextLength = 25) {
  const exact = range ? range.toString().trim() : '';
  const fullText = rootContainer ? (rootContainer.textContent || '') : '';

  let prefix = '';
  let suffix = '';

  if (fullText && exact) {
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(rootContainer);
      preRange.setEnd(range.startContainer, range.startOffset);
      const startOffset = preRange.toString().length;
      const endOffset = startOffset + exact.length;

      prefix = fullText.slice(Math.max(0, startOffset - contextLength), startOffset);
      suffix = fullText.slice(endOffset, Math.min(fullText.length, endOffset + contextLength));
    } catch {
      // Fallback if range endpoints cross shadow boundaries or complex nodes
      const idx = fullText.indexOf(exact);
      if (idx !== -1) {
        prefix = fullText.slice(Math.max(0, idx - contextLength), idx);
        suffix = fullText.slice(idx + exact.length, Math.min(fullText.length, idx + exact.length + contextLength));
      }
    }
  }

  return { exact, prefix, suffix };
}

/**
 * Locates the best matching character offset range for an anchor within plain text
 * Uses multi-tier strategy: Triplet -> Exact Substring -> Fuzzy Match (>= 0.8)
 * @param {string} text Full text content of the target container
 * @param {{ exact: string, prefix?: string, suffix?: string }} anchor
 * @param {number} [threshold=0.8]
 * @returns {{ start: number, end: number, confidence: number } | null}
 */
export function findAnchorPosition(text, anchor, threshold = 0.8) {
  if (!text || !anchor || !anchor.exact) return null;

  const { exact, prefix = '', suffix = '' } = anchor;

  // Level 1: Full Triplet Match (prefix + exact + suffix)
  if (prefix && suffix) {
    const fullTriplet = prefix + exact + suffix;
    const tripletIdx = text.indexOf(fullTriplet);
    if (tripletIdx !== -1) {
      const start = tripletIdx + prefix.length;
      return { start, end: start + exact.length, confidence: 1.0 };
    }
  }

  // Level 2: Exact substring match
  const exactIdx = text.indexOf(exact);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + exact.length, confidence: 1.0 };
  }

  // Level 3: Fuzzy re-anchoring (e.g. when user edited a few characters in exact)
  if (exact.length >= 4) {
    let bestMatch = null;
    let maxSim = 0;
    const step = Math.max(1, Math.floor(exact.length / 8));
    const winSize = exact.length;

    for (let i = 0; i <= text.length - winSize; i += step) {
      const candidate = text.slice(i, i + winSize);
      const sim = stringSimilarity(candidate, exact);
      if (sim > maxSim) {
        maxSim = sim;
        bestMatch = { start: i, end: i + winSize, confidence: sim };
      }
    }

    if (bestMatch && bestMatch.confidence >= threshold) {
      return bestMatch;
    }
  }

  return null;
}

/**
 * Collects all pure text nodes under an element (skips iframes, scripts, and existing highlights)
 * @param {Node} root
 * @returns {Text[]}
 */
export function getTextNodes(root) {
  if (!root) return [];
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_SKIP;

      const tag = parent.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'NOSCRIPT') {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.classList.contains('tp-highlight') || parent.closest('.tp-highlight')) {
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let currentNode;
  while ((currentNode = walker.nextNode())) {
    textNodes.push(currentNode);
  }
  return textNodes;
}

/**
 * Safely highlights text in an HTML container element using node splitting
 * Does NOT destroy sibling elements, iframes, or custom regex frontend markup
 * @param {HTMLElement} container
 * @param {string} entryId
 * @param {number} startOffset
 * @param {number} endOffset
 * @returns {HTMLElement | null} The created <mark> element
 */
export function applyHighlightToNode(container, entryId, startOffset, endOffset) {
  if (!container || startOffset >= endOffset) return null;

  // Check if highlight already exists
  const existing = container.querySelector(`mark.tp-highlight[data-entry-id="${entryId}"]`);
  if (existing) return existing;

  const textNodes = getTextNodes(container);
  let currentOffset = 0;

  for (const textNode of textNodes) {
    const textLen = textNode.textContent?.length || 0;
    const nodeStart = currentOffset;
    const nodeEnd = currentOffset + textLen;
    currentOffset = nodeEnd;

    // Check if this text node intersects with the target range
    if (endOffset > nodeStart && startOffset < nodeEnd) {
      const localStart = Math.max(0, startOffset - nodeStart);
      const localEnd = Math.min(textLen, endOffset - nodeStart);

      if (localStart >= localEnd) continue;

      try {
        // Safe splitting: split target portion into its own standalone text node
        let middleNode = textNode;
        if (localStart > 0) {
          middleNode = textNode.splitText(localStart);
        }
        if (localEnd - localStart < middleNode.textContent.length) {
          middleNode.splitText(localEnd - localStart);
        }

        const mark = document.createElement('mark');
        mark.className = 'tp-highlight';
        mark.setAttribute('data-entry-id', entryId);
        mark.title = '点击查看批改便签';

        middleNode.parentNode.replaceChild(mark, middleNode);
        mark.appendChild(middleNode);
        return mark;
      } catch (err) {
        console.warn('[TavernProofreader] Safe highlight split failed:', err);
      }
    }
  }

  return null;
}

/**
 * Removes a highlight mark and un-wraps its text content without calling normalize on container
 * @param {HTMLElement} container
 * @param {string} entryId
 */
export function removeHighlightFromNode(container, entryId) {
  if (!container) return;
  const mark = container.querySelector(`mark.tp-highlight[data-entry-id="${entryId}"]`);
  if (!mark) return;

  const parent = mark.parentNode;
  if (!parent) return;

  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
}

/**
 * Clears all proofreader highlight marks in the entire document safely
 */
export function clearAllHighlights() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('mark.tp-highlight').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  });
}
