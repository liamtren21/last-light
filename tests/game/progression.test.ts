import { describe, expect, it } from 'vitest';
import { story, initialState } from '../../src/game/story';
import { transition } from '../../src/game/reducer';

describe('complete story graph', () => {
  it('cannot finish a crossing in only three choices', () => {
    let frontier = [initialState()];
    for (let depth = 0; depth < 8; depth++) {
      const next = [];
      for (const state of frontier) {
        expect(story[state.sceneId]?.ending).toBeUndefined();
        const scene=story[state.sceneId]!;
        for (const choiceId of [...scene.choices.map(choice=>choice.id), ...(scene.next?['continue']:[])]) {
          const result = transition(state, { choiceId, expectedVersion: state.version, clientActionId: crypto.randomUUID() });
          if (result.ok) next.push(result.state);
        }
      }
      frontier = next;
    }
  });
  it('requires the signal inspection before allowing the final lever', () => {
    const state = { ...initialState(), sceneId: 'signal-room' };
    expect(transition(state, { choiceId: 'restore-signal', expectedVersion: 0, clientActionId: crypto.randomUUID() }).ok).toBe(false);
  });
  it('has linear dialogue beats and natural chapter checkpoints', () => {
    expect(Object.values(story).filter(scene => scene.next).length).toBeGreaterThanOrEqual(8);
    expect(Object.values(story).filter(scene => scene.checkpoint).length).toBe(2);
  });
});
