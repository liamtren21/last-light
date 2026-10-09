import type {GameState,Scene} from './schema';
import {story,initialState} from './story';
import {transition} from './reducer';

/** Read-only replay of witnessed scenes. Never infer unvisited story branches. */
export function witnessedScenes(state:GameState):Scene[]{
  const result:Scene[]=[story['ferry-first']!];let replay=initialState();
  for(const [index,action] of state.history.entries()){
    const choiceId=action===`continue:${replay.sceneId}`?'continue':action;
    const step=transition(replay,{choiceId,expectedVersion:replay.version,clientActionId:`recap-${index}`});
    if(!step.ok)return [];
    replay=step.state;result.push(story[replay.sceneId]!);
  }
  // Reading a malformed save must not reconstruct a route its state contradicts.
  const extraVersions=state.gameplayVersion===2?(state.cooperation??[]).length:0;
  if(replay.sceneId!==state.sceneId||replay.version+extraVersions!==state.version||replay.flags.some(flag=>!state.flags.includes(flag))||replay.inventory.some(item=>!state.inventory.includes(item)))return [];
  return result;
}
