import { z } from 'zod';
import { initialState, story } from './story';
import type { GameState } from './schema';
const legacy = z.object({sceneId:z.string(),version:z.number().int().nonnegative(),flags:z.array(z.string()),history:z.array(z.string())});
const current = legacy.extend({schemaVersion:z.literal(2),gameplayVersion:z.literal(2).optional(),cooperation:z.array(z.object({sceneId:z.string(),actionId:z.string(),memoryIds:z.array(z.string()),version:z.number().int().positive(),allowedChoices:z.array(z.string()).optional()})).optional(),unlockedChapters:z.array(z.number().int().min(1).max(3)),inventory:z.array(z.string()),completedEndings:z.array(z.enum(['signal','return']))});
export function restoreGameState(value:unknown):GameState {
  const parsed = current.safeParse(value);
  if(parsed.success){if(!story[parsed.data.sceneId])throw new Error('SAVE_SCENE_NOT_FOUND');return parsed.data;}
  if(value && typeof value==='object' && 'schemaVersion' in value)throw new Error('SAVE_VERSION_UNSUPPORTED');
  const old=legacy.parse(value); const scene=story[old.sceneId];
  if(!scene)throw new Error('SAVE_SCENE_NOT_FOUND');
  // Old demo saves keep completed endings; unfinished late scenes resume at an inspection.
  const state={...initialState(),...old};
  state.unlockedChapters=Array.from({length:scene.chapter},(_,i)=>i+1);
  if(scene.chapter>=2){state.flags=[...new Set([...state.flags,'survey-complete'])];state.inventory=['coast-map','passenger-list'];}
  if(old.sceneId==='signal-room'){state.sceneId='signal-inspection';state.flags.push('station-reached');}
  if(scene.ending){state.completedEndings=[scene.ending];if(scene.ending==='return')state.flags.push('passengers-accounted');}
  return state;
}
