import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { segmentGraphemes } from './graphemes';

export type TypewriterOptions = {
  identity: string;
  speedMs?: number;
  reducedMotion?: boolean;
};

export type TypewriterState = {
  visibleText: string;
  isComplete: boolean;
  reveal: () => void;
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return reduced;
}

/** Type one grapheme at a time. Changing identity or text cancels the prior line. */
export function useTypewriter(text: string, options: TypewriterOptions): TypewriterState {
  const { identity, speedMs = 24, reducedMotion } = options;
  const prefersReducedMotion = usePrefersReducedMotion();
  const immediate = reducedMotion ?? prefersReducedMotion;
  const graphemes = useMemo(() => segmentGraphemes(text), [text]);
  const lineKey = `${identity}\u0000${text}`;
  const [progress, setProgress] = useState({ lineKey, count: immediate ? graphemes.length : 0 });
  const countRef = useRef(progress.count);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    countRef.current = 0;
    setProgress({ lineKey, count: immediate ? graphemes.length : 0 });
    if (immediate || graphemes.length === 0) {
      countRef.current = graphemes.length;
      return () => { cancelled = true; };
    }

    timer = setInterval(() => {
      if (cancelled) return;
      const next = Math.min(countRef.current + 1, graphemes.length);
      countRef.current = next;
      setProgress({ lineKey, count: next });
      if (next >= graphemes.length && timer !== undefined) clearInterval(timer);
    }, Math.max(1, speedMs));

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [graphemes, immediate, lineKey, speedMs]);

  const reveal = useCallback(() => {
    countRef.current = graphemes.length;
    setProgress({ lineKey, count: graphemes.length });
  }, [graphemes.length, lineKey]);

  // Never show a stale prefix while the effect for a new line is waiting to run.
  const count = progress.lineKey === lineKey ? progress.count : immediate ? graphemes.length : 0;
  return {
    visibleText: graphemes.slice(0, count).join(''),
    isComplete: count >= graphemes.length,
    reveal,
  };
}
