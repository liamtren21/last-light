/** Split text into user-perceived characters, keeping combining marks and joined emoji intact. */
export function segmentGraphemes(text: string): string[] {
  const segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;

  if (segmenter) {
    return Array.from(new segmenter(undefined, { granularity: 'grapheme' }).segment(text), ({ segment }) => segment);
  }

  // Small fallback for runtimes without Intl.Segmenter: merge marks, variation selectors,
  // emoji modifiers, keycaps, regional indicator pairs, and zero-width-joiner sequences.
  const points = Array.from(text);
  const result: string[] = [];
  const isMark = (point: string) => /\p{Mark}/u.test(point);
  const isVariation = (point: string) => {
    const code = point.codePointAt(0) ?? 0;
    return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
  };
  const isModifier = (point: string) => {
    const code = point.codePointAt(0) ?? 0;
    return code >= 0x1f3fb && code <= 0x1f3ff;
  };
  const isRegional = (point: string) => {
    const code = point.codePointAt(0) ?? 0;
    return code >= 0x1f1e6 && code <= 0x1f1ff;
  };

  for (const point of points) {
    const previous = result.at(-1);
    const joinsPrevious = previous !== undefined && (
      isMark(point) || isVariation(point) || isModifier(point) || point === '\u20e3' ||
      point === '\u200d' || previous.endsWith('\u200d') ||
      (isRegional(point) && Array.from(previous).length === 1 && isRegional(previous))
    );
    if (joinsPrevious) result[result.length - 1] += point;
    else result.push(point);
  }
  return result;
}
