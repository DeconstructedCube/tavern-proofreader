/**
 * Tavern Proofreader - W3C TextQuoteSelector & Fuzzy Re-anchoring Engine
 * Provides resilient text highlighting across Markdown re-renders and edits
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
  const exact = range.toString().trim();
  const fullText = rootContainer.textContent || '';

  // Get start and end character offsets relative to rootContainer's textContent
  const preRange = document.createRange();
  preRange.selectNodeContents(rootContainer);
  preRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = preRange.toString().length;
  const endOffset = startOffset + exact.length;

  const prefix = fullText.slice(Math.max(0, startOffset - contextLength), startOffset);
  const suffix = fullText.slice(endOffset, Math.min(fullText.length, endOffset + contextLength));

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
 * Collects all pure text nodes under an element
 * @param {Node} root
 * @returns {Text[]}
 */
export function getTextNodes(root) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Don't descend into existing proofreader highlights
      if (node.parentElement && node.parentElement.classList.contains('tp-highlight')) {
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
 * Highlights a text range in an HTML container element by wrapping it in <mark>
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
  let startNode = null;
  let startNodeOffset = 0;
  let endNode = null;
  let endNodeOffset = 0;

  for (const node of textNodes) {
    const nodeLen = node.textContent?.length || 0;
    const nodeEnd = currentOffset + nodeLen;

    if (!startNode && startOffset >= currentOffset && startOffset <= nodeEnd) {
      startNode = node;
      startNodeOffset = startOffset - currentOffset;
    }
    if (!endNode && endOffset >= currentOffset && endOffset <= nodeEnd) {
      endNode = node;
      endNodeOffset = endOffset - currentOffset;
      break;
    }
    currentOffset = nodeEnd;
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);

    const mark = document.createElement('mark');
    mark.className = 'tp-highlight';
    mark.setAttribute('data-entry-id', entryId);
    mark.title = '点击查看编审批改';

    range.surroundContents(mark);
    return mark;
  } catch (err) {
    // If range crosses complex node boundaries, fallback safely without throwing
    console.warn('[TavernProofreader] Could not surround range cleanly:', err);
    return null;
  }
}

/**
 * Removes a highlight mark from a container and merges text nodes
 * @param {HTMLElement} container
 * @param {string} entryId
 */
export function removeHighlightFromNode(container, entryId) {
  if (!container) return;
  const mark = container.querySelector(`mark.tp-highlight[data-entry-id="${entryId}"]`);
  if (!mark) return;

  const parent = mark.parentNode;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}
