import { describe, it, expect } from 'bun:test';
import { computeUnifiedDiff } from '../src/diff-engine.js';
import {
  collectActiveCoordinates,
  buildCoordinateString,
  proofreaderGenerateInterceptor,
} from '../src/interceptor.js';
import {
  levenshteinDistance,
  stringSimilarity,
  findAnchorPosition,
} from '../src/anchor.js';
import {
  buildProofreadMessageText,
  formatDiffHtml,
} from '../src/card-renderer.js';

describe('Tavern Proofreader - Diff Engine', () => {
  it('returns empty string when original and revised are identical', () => {
    const text = '只见他冷笑一声，拔出长剑。';
    expect(computeUnifiedDiff(text, text)).toBe('');
  });

  it('computes standard unified diff with @@ hunk header for single line', () => {
    const original = '只见他冷笑一声，拔出长剑。';
    const revised = '只见他指尖微颤，按住剑鞘。';
    const diff = computeUnifiedDiff(original, revised);

    expect(diff).toContain('@@ -1 +1 @@');
    expect(diff).toContain('-只见他冷笑一声，拔出长剑。');
    expect(diff).toContain('+只见他指尖微颤，按住剑鞘。');
  });

  it('computes unified diff for multiline modifications', () => {
    const original = '第一行文本\n第二行被修改\n第三行未变';
    const revised = '第一行文本\n第二行已更新内容\n第三行未变';
    const diff = computeUnifiedDiff(original, revised);

    expect(diff).toContain('@@');
    expect(diff).toContain('-第二行被修改');
    expect(diff).toContain('+第二行已更新内容');
  });
});

describe('Tavern Proofreader - Interceptor & Coordinate Pointer', () => {
  it('collects active coordinates within sliding window', () => {
    const chat = [
      { mes: 'Hello', is_user: false }, // Turn 1 (idx 0)
      {
        mes: 'Critique',
        is_user: true,
        extra: {
          proofreader: {
            isProofreadNote: true,
            targetMessageIndex: 0,
            entries: [{ id: '1' }],
          },
        },
      }, // Turn 2 (idx 1)
      { mes: 'Story 1', is_user: false }, // Turn 3 (idx 2)
      { mes: 'Story 2', is_user: false }, // Turn 4 (idx 3)
      { mes: 'Current user input', is_user: true }, // Turn 5 (idx 4)
    ];

    const coords = collectActiveCoordinates(chat, 5);
    expect(coords.length).toBe(1);
    expect(coords[0].turn).toBe(1); // targetTurn = 0 + 1 = 1
    expect(coords[0].turnsAgo).toBe(4); // 5 - 1 = 4
  });

  it('builds coordinate pointer string correctly', () => {
    const coords = [
      { turn: 12, turnsAgo: 4 },
      { turn: 14, turnsAgo: 2 },
    ];
    const str = buildCoordinateString(coords);
    expect(str).toBe('[批注历史: 第 12 楼 (4 轮前), 第 14 楼 (2 轮前)]');
  });

  it('performs ephemeral injection on user message without mutating original chat', async () => {
    const originalUserMes = '我看着他，低声问道。';
    const chat = [
      {
        mes: 'AI text',
        is_user: false,
        extra: {
          proofreader: {
            isProofreadNote: true,
            targetMessageIndex: 0,
            entries: [{ id: 'e1' }],
          },
        },
      },
      {
        mes: originalUserMes,
        is_user: true,
      },
    ];

    const userMsgRef = chat[1];
    await proofreaderGenerateInterceptor(chat, 1000, () => {}, 'normal');

    // The chat[1] in the array should now be a cloned object with appended coordinate string
    expect(chat[1].mes).toContain('[批注历史: 第 1 楼 (1 轮前)]');
    // But the original object reference should remain pristine
    expect(userMsgRef.mes).toBe(originalUserMes);
  });
});

describe('Tavern Proofreader - W3C Anchor & Fuzzy Re-anchoring', () => {
  it('calculates string similarity correctly', () => {
    expect(stringSimilarity('hello', 'hello')).toBe(1);
    expect(stringSimilarity('hello', 'hallo')).toBe(0.8);
    expect(stringSimilarity('abc', 'xyz')).toBe(0);
  });

  it('finds exact triplet match when prefix, exact and suffix match', () => {
    const fullText = '夜幕降临，山风呼啸。只见他冷笑一声，拔出长剑。少年的目光依旧清澈。';
    const anchor = {
      exact: '只见他冷笑一声，拔出长剑。',
      prefix: '夜幕降临，山风呼啸。',
      suffix: '少年的目光依旧清澈。',
    };

    const match = findAnchorPosition(fullText, anchor);
    expect(match).not.toBeNull();
    expect(match.confidence).toBe(1);
    expect(fullText.slice(match.start, match.end)).toBe(anchor.exact);
  });

  it('fuzzy matches when user made slight edits to original text', () => {
    // User edited "拔出长剑" to "拔出宝剑" (1 character difference)
    const fullText = '夜幕降临，山风呼啸。只见他冷笑一声，拔出宝剑。少年的目光依旧清澈。';
    const anchor = {
      exact: '只见他冷笑一声，拔出长剑。',
      prefix: '夜幕降临，山风呼啸。',
      suffix: '少年的目光依旧清澈。',
    };

    const match = findAnchorPosition(fullText, anchor);
    expect(match).not.toBeNull();
    expect(match.confidence).toBeGreaterThanOrEqual(0.8);
    expect(fullText.slice(match.start, match.end)).toBe('只见他冷笑一声，拔出宝剑。');
  });

  it('returns null safely when text is completely missing without throwing', () => {
    const fullText = '完全不相关的另外一段文字。';
    const anchor = {
      exact: '只见他冷笑一声，拔出长剑。',
    };
    expect(findAnchorPosition(fullText, anchor)).toBeNull();
  });
});

describe('Tavern Proofreader - Card Renderer Text Builder', () => {
  it('generates standard markdown with diff block and constraint footer', () => {
    const entries = [
      {
        id: '1',
        diffHunk: '@@ -1 +1 @@\n-原句\n+新句',
        instruction: '更加含蓄',
      },
    ];

    const text = buildProofreadMessageText(entries, 3);
    expect(text).toContain('【正文批改与修润建议】');
    expect(text).toContain('针对第 3 楼正文提出以下修改意见：');
    expect(text).toContain('```diff\n@@ -1 +1 @@\n-原句\n+新句\n```');
    expect(text).toContain('> 指导意见：更加含蓄');
    expect(text).toContain('【写作指导】');
    expect(text).toContain('无需复述历史修改内容');
  });

  it('formats diff html with syntax highlight spans', () => {
    const diffHunk = '@@ -1 +1 @@\n-old\n+new\n context';
    const html = formatDiffHtml(diffHunk);
    expect(html).toContain('<span class="tp-diff-hunk">@@ -1 +1 @@</span>');
    expect(html).toContain('<span class="tp-diff-del">-old</span>');
    expect(html).toContain('<span class="tp-diff-add">+new</span>');
    expect(html).toContain('<span class="tp-diff-context"> context</span>');
  });
});
