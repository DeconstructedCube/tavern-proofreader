/**
 * Tavern Proofreader - Ephemeral UserInput Interceptor
 * Injects pure coordinate pointers into outgoing prompt without polluting chat records
 */

export const DEFAULT_SLIDING_WINDOW = 5;

/**
 * Collects active editorial note coordinates within the sliding window
 * @param {Array<object>} chat The chat message array
 * @param {number} [windowSize=DEFAULT_SLIDING_WINDOW]
 * @returns {Array<{ turn: number, turnsAgo: number }>}
 */
export function collectActiveCoordinates(chat, windowSize = DEFAULT_SLIDING_WINDOW) {
  if (!Array.isArray(chat) || chat.length === 0) {
    return [];
  }

  const currentTurn = chat.length;
  const coordinates = [];
  const seenTurns = new Set();

  // Scan recent messages backwards
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    const proofreader = msg?.extra?.proofreader;

    if (proofreader?.isProofreadNote && Array.isArray(proofreader.entries) && proofreader.entries.length > 0) {
      const targetIndex = typeof proofreader.targetMessageIndex === 'number' ? proofreader.targetMessageIndex : i - 1;
      const targetTurn = targetIndex + 1;
      const turnsAgo = Math.max(1, currentTurn - targetTurn);

      if (turnsAgo <= windowSize && !seenTurns.has(targetTurn)) {
        seenTurns.add(targetTurn);
        coordinates.push({ turn: targetTurn, turnsAgo });
      }
    }
  }

  // Sort chronologically ascending (older turn first)
  coordinates.sort((a, b) => a.turn - b.turn);
  return coordinates;
}

/**
 * Builds the pure coordinate pointer string
 * e.g. "[Editorial History: Turn #12 (4 turns ago), Turn #14 (2 turns ago)]"
 * @param {Array<{ turn: number, turnsAgo: number }>} coordinates
 * @returns {string|null}
 */
export function buildCoordinateString(coordinates) {
  if (!coordinates || coordinates.length === 0) {
    return null;
  }

  const parts = coordinates.map((coord) => `第 ${coord.turn} 楼 (${coord.turnsAgo} 轮前)`);
  return `[批注历史: ${parts.join(', ')}]`;
}

/**
 * Global generate_interceptor handler registered in SillyTavern
 * @param {Array<object>} chat
 * @param {number} contextSize
 * @param {Function} abort
 * @param {string} type
 */
export async function proofreaderGenerateInterceptor(chat, contextSize, abort, type) {
  try {
    if (!Array.isArray(chat) || chat.length === 0) return;

    // Collect active coordinates
    const coordinates = collectActiveCoordinates(chat, DEFAULT_SLIDING_WINDOW);
    const pointerText = buildCoordinateString(coordinates);

    if (!pointerText) return;

    // Ephemeral injection: find the last user message
    const lastIndex = chat.length - 1;
    const lastMsg = chat[lastIndex];

    if (lastMsg && lastMsg.is_user) {
      // Use structuredClone so the in-memory chat history is not permanently mutated
      const cloned = typeof structuredClone === 'function' ? structuredClone(lastMsg) : JSON.parse(JSON.stringify(lastMsg));
      cloned.mes = (cloned.mes || '').trimEnd() + '\n\n' + pointerText;
      chat[lastIndex] = cloned;
    }
  } catch (err) {
    console.error('[TavernProofreader] Interceptor error:', err);
  }
}
