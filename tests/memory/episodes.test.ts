import { describe, expect, it } from 'vitest';
import { buildActionEpisode } from '../../server/memory/episodes';
import { envelopeSchema } from '../../server/memory/extract';
import { transition } from '../../src/game/reducer';
import { initialState } from '../../src/game/story';
import { commitCooperation, cooperationOptions, needsCooperation, cooperationComplete } from '../../src/game/cooperation';
import type { GameState } from '../../src/game/schema';

const campaign = '00000000-0000-4000-8000-000000000001';
const event = '00000000-0000-4000-8000-000000000002';
const firstChapter = ['ask-map', 'continue', 'continue', 'ridge-route', 'mark-channel', 'promise-meet'];
const station = [...firstChapter, 'continue', 'try-tower', 'inspect-steps', 'continue-together', 'continue', 'continue', 'check-cable', 'continue', 'arm-controller'];
const returnCount = [...firstChapter, 'continue', 'safe-return', 'call-from-steps', 'continue'];
function move(before: GameState, choiceId: string) {
  const result = transition(before, { choiceId, expectedVersion: before.version, clientActionId: event });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}
function path(choices: string[]) {
  return choices.reduce(move, initialState());
}
function episode(choices: string[], choiceId: string) {
  const before = path(choices);
  return buildActionEpisode(before, move(before, choiceId), choiceId, campaign, event);
}

describe('engine-confirmed action episodes', () => {
  it('records a fulfilled meeting only after returning from the first pause', () => {
    expect(episode(firstChapter.slice(0, -1), 'promise-meet')).toBeNull();
    const memory = episode(firstChapter, 'continue');
    expect(memory).toMatchObject({ kind: 'episode', source: { type: 'game', id: event }, revision: 1 });
    expect(memory?.text).toMatch(/meeting|rendezvous/i);
    expect(memory?.text).toMatch(/returned|reunited/i);
    expect(memory?.factKey).toBe(`episode.${memory?.memoryId}`);
    expect(envelopeSchema.safeParse(memory).success).toBe(true);
  });

  it('does not invent a promise when the player stayed in sight', () => {
    expect(episode([...firstChapter.slice(0, -1), 'stay-in-sight'], 'continue')).toBeNull();
  });

  it.each([
    [[...firstChapter, 'continue'], 'safe-return'],
    [[...firstChapter, 'continue', 'try-tower'], 'turn-back'],
    [[...firstChapter, 'continue', 'try-tower', 'inspect-steps'], 'leave-steps'],
    [station, 'save-charge'],
  ] as [string[], string][])('records completed safety decisions without inventing betrayal: %s / %s', (choices, choiceId) => {
    const memory = episode(choices, choiceId);
    expect(memory?.text).toMatch(/return|back|charge/i);
    expect(memory?.text).not.toMatch(/broke|betray|abandon.*promise|reason/i);
    expect(memory?.text.length).toBeLessThanOrEqual(500);
    expect(memory?.text).not.toMatch(/six passengers.*(?:safe|accounted)|two flashes|signal restored/i);
  });

  it('records the six passengers only after checking all names', () => {
    expect(episode(returnCount.slice(0, -1), 'continue')).toBeNull();
    const memory = episode(returnCount, 'check-passengers');
    expect(memory?.text).toMatch(/six passengers/i);
    expect(memory?.text).toMatch(/list|names/i);
  });

  it.each(['leave-warning', 'keep-watch'])('records the actual safe-return ending choice: %s', choiceId => {
    const memory = episode([...returnCount, 'check-passengers', 'continue'], choiceId);
    expect(memory?.text).toMatch(/six passengers/i);
    expect(memory?.text).toMatch(choiceId === 'leave-warning' ? /posted|pinned/ : /watch/);
    expect(memory?.text).not.toMatch(/signal restored|two flashes/i);
  });

  it('records the signal ending only after the controller is armed and the warning sent', () => {
    expect(episode(station.slice(0, -1), 'arm-controller')).toBeNull();
    expect(episode(station, 'restore-signal')?.text).toMatch(/sent.*flood warning/i);
    expect(episode(station, 'restore-signal')?.text).not.toMatch(/six passengers.*safe/i);
  });

  it('rejects incomplete, mismatched, and forged transitions', () => {
    const before = path(firstChapter);
    const after = move(before, 'continue');
    expect(buildActionEpisode(before, before, 'continue', campaign, event)).toBeNull();
    expect(buildActionEpisode(before, after, 'restore-signal', campaign, event)).toBeNull();
    expect(buildActionEpisode(before, { ...after, history: [...after.history, 'restore-signal'] }, 'continue', campaign, event)).toBeNull();
    expect(buildActionEpisode(before, { ...after, flags: [...after.flags, 'passengers-accounted'] }, 'continue', campaign, event)).toBeNull();
    expect(buildActionEpisode(before, { ...after, version: before.version }, 'continue', campaign, event)).toBeNull();
    expect(buildActionEpisode(before, { ...after, sceneId: 'ending-signal' }, 'continue', campaign, event)).toBeNull();
  });

  it('rejects forged prior history and story flags even if a reducer transition can run', () => {
    const before = path(firstChapter);
    const forged = { ...before, history: ['promise-meet'], flags: [...before.flags, 'passengers-accounted'] };
    expect(buildActionEpisode(forged, move(forged, 'continue'), 'continue', campaign, event)).toBeNull();
    const fabricated = { ...before, history: before.history.filter(id => id !== 'promise-meet') };
    expect(buildActionEpisode(fabricated, move(fabricated, 'continue'), 'continue', campaign, event)).toBeNull();
  });

  it('keeps IDs stable for retries, scoped to campaign and action event', () => {
    const before = path(firstChapter);
    const after = move(before, 'continue');
    const memory = buildActionEpisode(before, after, 'continue', campaign, event)!;
    expect(buildActionEpisode(before, after, 'continue', campaign, event)?.memoryId).toBe(memory.memoryId);
    expect(buildActionEpisode(before, after, 'continue:first-pause', campaign, event)?.memoryId).toBe(memory.memoryId);
    expect(buildActionEpisode(before, after, 'continue', event, event)?.memoryId).not.toBe(memory.memoryId);
    expect(buildActionEpisode(before, after, 'continue', campaign, campaign)?.memoryId).not.toBe(memory.memoryId);
  });

  it('supports real cooperation-authorized actions without copying the raw plan reason', () => {
    let before = initialState({ gameplayVersion: 2 });
    const plan = { meeting: 'water-tower', priority: 'signal', reason: 'SECRET USER REASON' } as const;
    for (const choice of firstChapter) {
      if (needsCooperation(before) && !cooperationComplete(before)) before = commitCooperation(before, cooperationOptions(before, plan)[0]!, [event]);
      before = move(before, choice);
    }
    const after = move(before, 'continue');
    const memory = buildActionEpisode(before, after, 'continue', campaign, event);
    expect(memory?.text).toMatch(/meeting|rendezvous/i);
    expect(memory?.text).not.toContain(plan.reason);
    const unconfirmed = { ...path(firstChapter), gameplayVersion: 2 as const, sceneId: 'chapter-two' };
    const forgedAfter = { ...unconfirmed, sceneId: 'return-call', version: unconfirmed.version + 1, flags: [...unconfirmed.flags, 'return-chosen'], history: [...unconfirmed.history, 'safe-return'] };
    expect(buildActionEpisode(unconfirmed, forgedAfter, 'safe-return', campaign, event)).toBeNull();
  });
});
