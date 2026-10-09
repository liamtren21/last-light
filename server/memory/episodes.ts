import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GameState } from '../../src/game/schema';
import { transition } from '../../src/game/reducer';
import { initialState, story } from '../../src/game/story';
import { envelopeSchema, type MemoryEnvelope } from './extract';

const coordinationFlags = new Set(['passenger-list-coordinated', 'warning-radio-coordinated', 'cooperation-repair-prepared']);
const sorted = (values: string[]) => [...values].sort();

/** Replay authored choices, without reconstructing any remembered cooperation plan.
 * Cooperation authorizations are checked by the real transition below; the replay
 * only verifies that the story facts actually follow from the recorded history. */
function hasConsistentStoryHistory(state: GameState): boolean {
  let replay = initialState();
  for (const choiceId of state.history) {
    const inputId = choiceId === `continue:${replay.sceneId}` && story[replay.sceneId]?.next ? 'continue' : choiceId;
    const result = transition(replay, { choiceId: inputId, expectedVersion: replay.version, clientActionId: 'history-check' });
    if (!result.ok || result.state.history.at(-1) !== choiceId) return false;
    replay = result.state;
  }
  const storyFlags = state.flags.filter(flag => !coordinationFlags.has(flag));
  return state.schemaVersion === replay.schemaVersion && state.sceneId === replay.sceneId
    && Number.isInteger(state.version) && state.version >= replay.version
    && isDeepStrictEqual(sorted(storyFlags), sorted(replay.flags))
    && isDeepStrictEqual(sorted(state.inventory), sorted(replay.inventory))
    && isDeepStrictEqual(state.unlockedChapters, replay.unlockedChapters)
    && isDeepStrictEqual(state.completedEndings, replay.completedEndings);
}

function episodeText(before: GameState, after: GameState, actionId: string): string | null {
  const has = (...flags: string[]) => flags.every(flag => after.flags.includes(flag));
  switch (actionId) {
    case 'continue:first-pause':
      return before.sceneId === 'first-pause' && after.sceneId === 'chapter-two'
        && before.history.includes('promise-meet') && has('made-meeting-plan', 'survey-complete')
        ? 'After making a meeting plan, the player returned to Mira under the ferry shelter roof. They reunited after waiting out the squall.' : null;
    case 'safe-return':
      return before.sceneId === 'chapter-two' && after.sceneId === 'return-call' && has('return-chosen')
        ? 'With the landing worsening, the player and Mira chose to bring the waiting passengers back to shelter. The passenger count had not yet been checked.' : null;
    case 'turn-back':
      return before.sceneId === 'tower-road' && after.sceneId === 'return-descent' && has('return-chosen')
        ? 'At the water tower, the player chose to turn back with Mira because the path was too slick. They began the return down the steps.' : null;
    case 'leave-steps':
      return before.sceneId === 'tower-inspection' && after.sceneId === 'return-descent' && has('steps-inspected', 'return-chosen')
        ? 'After inspecting the handrail and finding a loose top step, the player and Mira chose the safe path back and began their descent.' : null;
    case 'save-charge':
      return before.sceneId === 'signal-room' && after.sceneId === 'return-descent'
        && has('signal-inspected', 'warning-selected', 'return-chosen', 'charge-preserved')
        ? 'With the flood warning selected, the player and Mira kept the battery charge and began returning to carry the warning back themselves. They did not send the station warning.' : null;
    case 'check-passengers':
      return before.sceneId === 'return-count' && after.sceneId === 'return-confirmed'
        && has('return-organized', 'passengers-accounted') && after.inventory.includes('passenger-list')
        ? 'The player and Mira checked all six names on the passenger list against the six passengers under the ferry shelter roof. All six were accounted for and the gate was shut.' : null;
    case 'restore-signal':
      return before.sceneId === 'signal-room' && after.sceneId === 'ending-signal'
        && has('signal-inspected', 'warning-selected', 'ending-signal') && after.completedEndings.includes('signal')
        ? 'The player and Mira sent the selected flood warning from the signal station. Two flashes came back from the harbor, confirming that the warning had been seen.' : null;
    case 'leave-warning':
    case 'keep-watch':
      if (before.sceneId !== 'return-plan' || after.sceneId !== 'ending-return'
        || !has('passengers-accounted', 'ending-return') || !after.completedEndings.includes('return')) return null;
      if (actionId === 'leave-warning' && has('warning-posted')) return 'With all six passengers accounted for under the ferry shelter roof, the player and Mira pinned a flood warning beside the ferry board before resting.';
      if (actionId === 'keep-watch' && has('watch-arranged')) return 'With all six passengers accounted for under the ferry shelter roof, the player and Mira arranged the first watch by the gate before resting.';
      return null;
    default:
      return null;
  }
}

/** Derive a short episode only from a completed, server-authoritative action.
 * Call after reducer success, inside the action transaction. The stable ID lets
 * queue retries reuse the same logical memory; it is not a storage receipt. */
export function buildActionEpisode(before: GameState, after: GameState, choiceId: string, campaignId: string, eventId: string): MemoryEnvelope | null {
  if (!hasConsistentStoryHistory(before) || !eventId.trim()) return null;
  const inputId = choiceId === `continue:${before.sceneId}` && story[before.sceneId]?.next ? 'continue' : choiceId;
  const result = transition(before, { choiceId: inputId, expectedVersion: before.version, clientActionId: eventId });
  if (!result.ok || !isDeepStrictEqual(result.state, after)) return null;
  const actionId = after.history.at(-1)!;
  const text = episodeText(before, after, actionId);
  if (!text || text.length > 500) return null;
  const chars = createHash('sha256').update(JSON.stringify(['action-episode-v1', campaignId, eventId, actionId])).digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const memoryId = `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20).join('')}`;
  const parsed = envelopeSchema.safeParse({ schemaVersion: 1, memoryId, campaignId, characterId: 'mira', kind: 'episode', factKey: `episode.${memoryId}`, revision: 1, text, source: { type: 'game', id: eventId }, occurredAt: new Date().toISOString() });
  return parsed.success ? parsed.data : null;
}
