import type { Action, GameState } from './schema';
import { story, availableChoices } from './story';
import {needsCooperation,cooperationComplete} from './cooperation';

export function transition(state: GameState, action: Action): { ok: true; state: GameState } | { ok: false; error: string } {
  const scene = story[state.sceneId];
  if (!scene) return { ok: false, error: 'SCENE_NOT_FOUND' };
  if (action.expectedVersion !== state.version) return { ok: false, error: 'VERSION_CONFLICT' };
  if(needsCooperation(state)&&!cooperationComplete(state))return {ok:false,error:'COOPERATION_REQUIRED'};
  if(needsCooperation(state)&&![...(state.cooperation??[])].reverse().find(event=>event.sceneId===state.sceneId)?.allowedChoices?.includes(action.choiceId))return {ok:false,error:'PLAN_ACTION_MISMATCH'};
  const choice = action.choiceId === 'continue' && scene.next
    ? { id: `continue:${scene.id}`, next: scene.next, sets: [] as string[], gives: [] as string[] }
    : availableChoices(state).find((item) => item.id === action.choiceId);
  if (!choice || !story[choice.next]) return { ok: false, error: 'ACTION_NOT_ALLOWED' };
  const flags = [...new Set([...state.flags, ...(choice.sets ?? [])])];
  const target = story[choice.next]!;
  if (!(target.requires ?? []).every(flag => flags.includes(flag))) return { ok: false, error: 'PREREQUISITE_MISSING' };
  return { ok: true, state: {
    ...state, sceneId: choice.next, version: state.version + 1,
    flags,
    inventory: [...new Set([...state.inventory, ...(choice.gives ?? [])])],
    unlockedChapters: [...new Set([...state.unlockedChapters, target.chapter])].sort(),
    completedEndings: target.ending ? [...new Set([...state.completedEndings, target.ending])] : state.completedEndings,
    history: [...state.history, choice.id],
  } };
}
