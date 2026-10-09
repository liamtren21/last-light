import { availableChoices, story } from '../../src/game/story';
import type { GameState } from '../../src/game/schema';
export type RecentTurn = { player: string; mira: string };
const physicalFlags=new Set(['saw-map','channel-observed','landing-observed','waterline-marked','passengers-warned','steps-inspected','station-reached','cable-checked','shutter-checked','signal-inspected','warning-selected','ending-signal','ending-return','passengers-accounted','warning-posted','watch-arranged']);
export type ReplyContext = { state?: GameState; recentTurns?: RecentTurn[]; purpose?: 'conversation'|'revisit'; onRejected?:(dialogue:string,error:unknown)=>void; coordination?:{technique:'pair-check'|'call-response';cue:string}; clarification?:{text:string;confirmed:boolean}; cooperation?:{allowedActions:string[];observations:string[];instruction:string} };
export function buildReplyContext(sceneId: string, message: string, memories: string[], context: ReplyContext = {}) {
  const scene = story[sceneId];
  if (!scene) throw new Error('SCENE_NOT_FOUND');
  const actions = context.state ? availableChoices(context.state) : scene.choices.filter(choice => !choice.requires?.length);
  const names=memories.slice(0,12).flatMap(fact=>{
    const match=/^(?:The player said \(not proof of completed game actions\):\s*)?(?:Please remember:\s*)?Call me ([\p{L}][\p{L}\p{M}'’ -]{0,79})\.?$/iu.exec(fact.trim());
    return match?[match[1]!.trim()]:[];
  });
  return {
    sceneId, sceneCanon: { speaker:'mira',place: scene.place, dialogue: scene.mira },
    playerName:names.length===1?names[0]:undefined,
    coordination:context.coordination?{...context.coordination,caller:'mira',responder:'player',instruction:'Mira says the cue and waits for the player to answer. At the rescue, passengers answer their names. The player taught the method; teaching it does not make the player the caller.'}:undefined,
    sceneActors:sceneId==='ferry-rendezvous'?{mira:'fetch the station key',player:'check the landing'}:undefined,
    purpose: context.purpose??'conversation',
    allowedActions: context.cooperation?.allowedActions??actions.map(choice => choice.id),
    cooperation:context.cooperation,
    clarification:context.clarification,
    verifiedGameState: context.state ? { inventory: context.state.inventory, completedActions: context.state.gameplayVersion===2?context.state.flags.filter(flag=>physicalFlags.has(flag)):context.state.history.slice(-12).filter(id=>!id.startsWith('cooperate:')) } : undefined,
    verifiedWalrusFacts: memories.slice(0, 12),
    currentVisit: (context.cooperation?[]:context.recentTurns ?? []).slice(-4).map(turn => ({ player: turn.player.slice(0,2000), mira: turn.mira.slice(0,1000) })),
    playerMessage: message.slice(0,2000),
  };
}
