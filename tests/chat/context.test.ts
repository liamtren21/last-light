import {describe,it,expect} from 'vitest';
import {buildReplyContext} from '../../server/chat/context';
import {initialState} from '../../src/game/story';
describe('Mira context boundary',()=>{
  it('keeps current visit bounded and excludes future story and personal facts from game state',()=>{
    const state=initialState();
    const context=buildReplyContext(state.sceneId,'What now?',[],{state,recentTurns:Array.from({length:8},(_,i)=>({player:`turn ${i}`,mira:'reply'}))});
    expect(context.currentVisit).toHaveLength(4);
    expect(context.currentVisit[0]?.player).toBe('turn 4');
    expect(context.verifiedWalrusFacts).toEqual([]);
    expect(JSON.stringify(context)).not.toContain('Six names, six passengers');
    expect(context.allowedActions).not.toContain('restore-signal');
  });
  it('a new visit has no prior transcript and memory OFF leaves game context identical',()=>{
    const state=initialState();const on=buildReplyContext(state.sceneId,'Hello',['Call me Rowan'],{state});
    const off=buildReplyContext(state.sceneId,'Hello',[],{state});
    expect(on.currentVisit).toEqual([]);expect(off).toEqual({...on,verifiedWalrusFacts:[],playerName:undefined});
  });
  it('does not offer an uninspected final lever even in that scene',()=>{
    const state={...initialState(),sceneId:'signal-room'};
    expect(buildReplyContext(state.sceneId,'Send it',[],{state}).allowedActions).not.toContain('restore-signal');
  });
});
