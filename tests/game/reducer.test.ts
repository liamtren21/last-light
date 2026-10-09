import { describe, expect, it } from 'vitest';
import { availableChoices, initialState, story } from '../../src/game/story';
import { transition } from '../../src/game/reducer';

describe('server-authoritative story transitions', () => {
  function act(state: ReturnType<typeof initialState>, choiceId: string) {
    return transition(state, { choiceId, expectedVersion: state.version, clientActionId: crypto.randomUUID() });
  }

  function move(state: ReturnType<typeof initialState>, choiceId: string): ReturnType<typeof initialState> {
    const result = act(state, choiceId);
    if (!result.ok) throw new Error(`Unexpected transition failure: ${result.error}`);
    return result.state;
  }

  it('rejects actions that are unavailable in the current scene', () => {
    expect(act(initialState(), 'restore-signal')).toEqual({ ok: false, error: 'ACTION_NOT_ALLOWED' });
  });

  it('rejects stale writes without changing the current state', () => {
    const state = initialState();
    expect(transition(state, { choiceId: 'ask-map', expectedVersion: 2, clientActionId: crypto.randomUUID() }))
      .toEqual({ ok: false, error: 'VERSION_CONFLICT' });
    expect(state.sceneId).toBe('ferry-first');
    expect(state.version).toBe(0);
  });

  it('allows Continue only on authored linear dialogue and records the transition', () => {
    const map = move(initialState(), 'ask-map');
    expect(map.sceneId).toBe('ferry-map');
    expect(act(map, 'continue')).toMatchObject({ ok: true, state: { sceneId: 'ferry-board' } });
    expect(act(initialState(), 'continue')).toEqual({ ok: false, error: 'ACTION_NOT_ALLOWED' });
    const continued = move(map, 'continue');
    expect(continued.history).toEqual(['ask-map', 'continue:ferry-map']);
    expect(continued.version).toBe(2);
  });

  it('requires the first checkpoint and unlocks chapter two only after the meeting plan', () => {
    let state = initialState();
    for (const choiceId of ['ask-map', 'continue', 'continue', 'ridge-route', 'mark-channel', 'promise-meet']) {
      state = move(state, choiceId);
    }
    expect(state.sceneId).toBe('first-pause');
    expect(story[state.sceneId]?.checkpoint).toBe(true);
    expect(state.unlockedChapters).toEqual([1]);
    state = move(state, 'continue');
    expect(state.sceneId).toBe('chapter-two');
    expect(state.unlockedChapters).toEqual([1, 2]);
    expect(state.flags).toContain('survey-complete');
    expect(state).not.toHaveProperty('transcript');
    expect(state).not.toHaveProperty('promise');
  });

  it('keeps the signal ending gated by inspection and controller setup', () => {
    const forged = { ...initialState(), sceneId: 'signal-room' };
    expect(act(forged, 'restore-signal')).toEqual({ ok: false, error: 'ACTION_NOT_ALLOWED' });

    let state = initialState();
    for (const choiceId of [
      'ask-map', 'continue', 'continue', 'ridge-route', 'mark-channel', 'promise-meet', 'continue',
      'try-tower', 'inspect-steps', 'continue-together', 'continue', 'continue', 'check-cable',
      'continue', 'arm-controller',
    ]) state = move(state, choiceId);

    expect(state.sceneId).toBe('signal-room');
    expect(availableChoices(state).map(({ id }) => id)).toEqual(['restore-signal', 'save-charge']);
    const ending = move(state, 'restore-signal');
    expect(ending.sceneId).toBe('ending-signal');
    expect(ending.completedEndings).toContain('signal');
  });

  it('can resolve the safe-return branch only after all six passengers are accounted for', () => {
    let state = initialState();
    for (const choiceId of [
      'ask-map', 'continue', 'continue', 'ridge-route', 'mark-channel', 'promise-meet', 'continue',
      'safe-return', 'call-from-steps', 'continue', 'check-passengers', 'continue', 'leave-warning',
    ]) state = move(state, choiceId);

    expect(state.sceneId).toBe('ending-return');
    expect(state.flags).toContain('passengers-accounted');
    expect(state.completedEndings).toContain('return');
  });
});
