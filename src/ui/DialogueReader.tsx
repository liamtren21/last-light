import { useEffect, useRef } from 'react';
import { useTypewriter } from './useTypewriter';
import { useGameKeys } from './useGameKeys';

export type DialogueReaderProps = {
  text: string;
  identity: string;
  onComplete?: () => void;
  onAdvance?: () => void;
  speedMs?: number;
  className?: string;
  keyboard?: boolean;
};

/** Paper-ready dialogue text with a complete, non-live accessible equivalent. */
export function DialogueReader({ text, identity, onComplete, onAdvance, speedMs, className, keyboard = true }: DialogueReaderProps) {
  const { visibleText, isComplete, reveal } = useTypewriter(text, { identity, speedMs });
  const lastCompleted = useRef<string | null>(null);
  const completionKey = `${identity}\u0000${text}`;
  useGameKeys({canReveal:()=>keyboard&&!isComplete,canAdvance:()=>keyboard&&isComplete&&Boolean(onAdvance),onReveal:reveal,onAdvance:()=>onAdvance?.()});

  useEffect(() => {
    if (!isComplete || lastCompleted.current === completionKey) return;
    lastCompleted.current = completionKey;
    onComplete?.();
  }, [completionKey, isComplete, onComplete]);

  if (!text) return null;

  return (
    <div className="dialogue-reader">
      <p className={className ?? 'dialogue-line'} aria-live="off">
        <span className="reader-measure" aria-hidden="true">{text}</span>
        <span className="reader-ink" aria-hidden="true">{visibleText}</span>
        <span className="visually-hidden">{text}</span>
      </p>
      {(!isComplete || onAdvance) && <button
        type="button"
        className="dialogue-reader-action"
        onClick={() => isComplete ? onAdvance?.() : reveal()}
        disabled={isComplete && !onAdvance}
        aria-label={isComplete ? (onAdvance ? 'Continue story' : 'Dialogue line revealed') : 'Reveal full dialogue line'}
      >
        {isComplete ? (onAdvance ? 'CONTINUE →' : 'LINE REVEALED') : 'REVEAL →'}
      </button>}
    </div>
  );
}
