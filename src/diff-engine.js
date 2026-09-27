/**
 * Tavern Proofreader - Lightweight Unified Diff Engine
 * Computes standard unified diffs with @@ -l,s +l,s @@ hunk headers
 */

/**
 * Split text into lines, preserving empty lines
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (!text) return [];
  // Normalize CRLF to LF then split
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * Computes Longest Common Subsequence (LCS) matrix
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]}
 */
function computeLcsMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  const matrix = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
      }
    }
  }
  return matrix;
}

/**
 * Backtrack LCS matrix to produce diff operations
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{ type: 'keep' | 'del' | 'add', text: string }>}
 */
function getDiffOperations(a, b) {
  const matrix = computeLcsMatrix(a, b);
  let i = a.length;
  let j = b.length;
  const ops = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: 'keep', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
      ops.unshift({ type: 'add', text: b[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || matrix[i][j - 1] < matrix[i - 1][j])) {
      ops.unshift({ type: 'del', text: a[i - 1] });
      i--;
    }
  }
  return ops;
}

/**
 * Generates a standard Unified Diff string
 * @param {string} originalText
 * @param {string} revisedText
 * @param {object} [options]
 * @param {number} [options.context=2] Context lines around changes
 * @returns {string} Unified Diff text (e.g. @@ -1,1 +1,1 @@\n- foo\n+ bar)
 */
export function computeUnifiedDiff(originalText, revisedText, options = {}) {
  const context = options.context ?? 2;
  const aLines = splitLines(originalText);
  const bLines = splitLines(revisedText);

  // If both are identical, no diff
  if (originalText === revisedText) {
    return '';
  }

  const ops = getDiffOperations(aLines, bLines);

  // Group operations into hunks with context
  const diffItems = [];
  let aIndex = 1;
  let bIndex = 1;

  for (const op of ops) {
    if (op.type === 'keep') {
      diffItems.push({ ...op, aLine: aIndex++, bLine: bIndex++ });
    } else if (op.type === 'del') {
      diffItems.push({ ...op, aLine: aIndex++, bLine: null });
    } else if (op.type === 'add') {
      diffItems.push({ ...op, aLine: null, bLine: bIndex++ });
    }
  }

  // Find change clusters (indices of ops that are 'add' or 'del')
  const changeIndices = [];
  diffItems.forEach((item, idx) => {
    if (item.type !== 'keep') {
      changeIndices.push(idx);
    }
  });

  if (changeIndices.length === 0) {
    return '';
  }

  // Merge nearby change clusters within context range
  const hunks = [];
  let currentHunk = null;

  for (const cIdx of changeIndices) {
    const start = Math.max(0, cIdx - context);
    const end = Math.min(diffItems.length - 1, cIdx + context);

    if (!currentHunk) {
      currentHunk = { start, end };
    } else if (start <= currentHunk.end + 1) {
      currentHunk.end = Math.max(currentHunk.end, end);
    } else {
      hunks.push(currentHunk);
      currentHunk = { start, end };
    }
  }
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  // Format hunks into unified diff text
  const resultLines = [];

  for (const hunk of hunks) {
    const slice = diffItems.slice(hunk.start, hunk.end + 1);

    // Calculate line counts for original (a) and new (b)
    let aCount = 0;
    let bCount = 0;
    let aStart = 0;
    let bStart = 0;

    for (const item of slice) {
      if (item.type === 'keep') {
        if (!aStart) aStart = item.aLine;
        if (!bStart) bStart = item.bLine;
        aCount++;
        bCount++;
      } else if (item.type === 'del') {
        if (!aStart) aStart = item.aLine;
        aCount++;
      } else if (item.type === 'add') {
        if (!bStart) bStart = item.bLine;
        bCount++;
      }
    }

    // Default fallbacks if start was 0
    aStart = aStart || 1;
    bStart = bStart || 1;

    // Hunk header: @@ -aStart,aCount +bStart,bCount @@
    const aPart = aCount === 1 ? `${aStart}` : `${aStart},${aCount}`;
    const bPart = bCount === 1 ? `${bStart}` : `${bStart},${bCount}`;
    resultLines.push(`@@ -${aPart} +${bPart} @@`);

    for (const item of slice) {
      if (item.type === 'keep') {
        resultLines.push(` ${item.text}`);
      } else if (item.type === 'del') {
        resultLines.push(`-${item.text}`);
      } else if (item.type === 'add') {
        resultLines.push(`+${item.text}`);
      }
    }
  }

  return resultLines.join('\n');
}
