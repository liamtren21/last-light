import { describe, expect, it } from 'vitest';
import { segmentGraphemes } from '../../src/ui/graphemes';
import { shouldIgnoreGameKeyEvent } from '../../src/ui/useGameKeys';

describe('segmentGraphemes', () => {
  it('keeps combining accents, joined emoji, and flags intact', () => {
    expect(segmentGraphemes('e\u0301👩‍👩‍👧‍👦🇻🇳')).toEqual(['e\u0301', '👩‍👩‍👧‍👦', '🇻🇳']);
  });

  it('keeps precomposed Vietnamese letters as one unit', () => {
    expect(segmentGraphemes('Mira vẫn ở đây.')).toEqual(['M', 'i', 'r', 'a', ' ', 'v', 'ẫ', 'n', ' ', 'ở', ' ', 'đ', 'â', 'y', '.']);
  });
});

describe('shouldIgnoreGameKeyEvent', () => {
  function keyEvent(key: string, target: unknown, overrides: Partial<KeyboardEvent> = {}) {
    return {
      key,
      target,
      defaultPrevented: false,
      repeat: false,
      isComposing: false,
      keyCode: 0,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      ...overrides,
    } as KeyboardEvent;
  }

  it('ignores text fields, editable regions, and buttons', () => {
    const target = (matches: string[], isContentEditable = false) => ({
      isContentEditable,
      closest: (selector: string) => matches.some((match) => selector.includes(match)) ? {} as Element : null,
    });
    const input = target(['input']);
    const textarea = target(['textarea']);
    const editable = target([], true);
    const button = target(['button']);
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', input))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent(' ', textarea))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', editable))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', button))).toBe(true);
  });

  it('ignores IME, modified, repeated, and unrelated keys while allowing scene keys on the body', () => {
    const page = { closest: () => null };
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', page, { isComposing: true }))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent(' ', page, { keyCode: 229 }))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', page, { repeat: true }))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', page, { ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent('g', page))).toBe(true);
    expect(shouldIgnoreGameKeyEvent(keyEvent(' ', page))).toBe(false);
    expect(shouldIgnoreGameKeyEvent(keyEvent('Enter', page))).toBe(false);
  });
});
