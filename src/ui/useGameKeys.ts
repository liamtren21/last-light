import { useEffect, useRef } from 'react';

export type GameKeyOptions = {
  canReveal: () => boolean;
  canAdvance: () => boolean;
  onReveal: () => void;
  onAdvance: () => void;
};

const INTERACTIVE_SELECTOR = [
  'input', 'textarea', 'select', 'button', 'a[href]', 'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="combobox"]',
  '[role="option"]', '[role="menuitem"]', '[role="slider"]',
].join(',');

/** Pure eligibility check, exported so keyboard behavior can be tested without a browser. */
export function shouldIgnoreGameKeyEvent(event: Pick<KeyboardEvent,
  'key' | 'target' | 'defaultPrevented' | 'repeat' | 'isComposing' | 'keyCode' | 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return true;
  if (event.ctrlKey || event.altKey || event.metaKey) return true;
  if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return true;

  const target = event.target;
  if (!target || typeof target !== 'object' || !('closest' in target)) return false;
  const element = target as EventTarget & { isContentEditable?: boolean; closest: (selectors: string) => Element | null };
  if (element.isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  return element.closest(INTERACTIVE_SELECTOR) !== null;
}

/** Space/Enter reveals the current line, then advances when the app says it is safe. */
export function useGameKeys(options: GameKeyOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGameKeyEvent(event)) return;
      const current = optionsRef.current;
      if (current.canReveal()) {
        event.preventDefault();
        current.onReveal();
      } else if (current.canAdvance()) {
        event.preventDefault();
        current.onAdvance();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
}
