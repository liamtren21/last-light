import {describe,expect,it} from 'vitest';
import {initialState,story} from '../../src/game/story';
import {transition} from '../../src/game/reducer';
import {cooperationOptions,commitCooperation,type CooperationPlan} from '../../src/game/cooperation';
import {buildReplyContext} from '../../server/chat/context';
import type {GameState} from '../../src/game/schema';
import {needsCooperation,cooperationComplete} from '../../src/game/cooperation';
import {witnessedScenes} from '../../src/game/recap';

function physicalState(sceneId='chapter-two'):GameState {
  return {...initialState(),gameplayVersion:2,sceneId,version:12,history:[],flags:['survey-complete','station-reached','signal-inspected','warning-selected','return-chosen','passengers-accounted'],inventory:['coast-map','passenger-list'],unlockedChapters:[1,2,3]};
}
function destinations(state:GameState){
  const scene=story[state.sceneId]!;
  return scene.choices.map(choice=>choice.id).concat(scene.next?['continue']:[]).flatMap(choiceId=>{
    const result=transition(state,{choiceId,expectedVersion:state.version,clientActionId:crypto.randomUUID()});
    return result.ok?[result.state.sceneId]:[];
  }).sort();
}
describe('product acceptance: remembering changes the game',()=>{
  it('same scene and physical facts with different priorities changes the executable next step',()=>{
    const state=physicalState();
    const plans:CooperationPlan[]=[{meeting:'shelter',priority:'passengers',reason:'Bring the waiting people under cover first.'},{meeting:'shelter',priority:'signal',reason:'Warn the approaching boats first.'}];
    const after=plans.map(plan=>{
      const options=cooperationOptions(state,plan);expect(options.length).toBeGreaterThan(0);
      return commitCooperation(state,options[0]!,[crypto.randomUUID()]);
    });
    // Different text, IDs or a generic unlock alone does not satisfy the feature.
    expect(after.map(s=>({scene:s.sceneId,next:destinations(s)}))[0]).not.toEqual(after.map(s=>({scene:s.sceneId,next:destinations(s)}))[1]);
  });
  it.each(['ferry-plan','ferry-rendezvous','chapter-two','signal-room','return-call','return-plan'])('cannot bypass required cooperation in %s with a normal choice or continue',sceneId=>{
    expect(destinations(physicalState(sceneId))).toEqual([]);
  });
  it('an OFF prompt cannot recover plan selections from cooperation events or old action IDs',()=>{
    const state=physicalState();
    state.history=['cooperate:ferry-plan:water-tower:passengers'];
    state.cooperation=[{sceneId:'ferry-plan',actionId:'cooperate:ferry-plan:water-tower:passengers',memoryIds:[crypto.randomUUID()],version:1}];
    const context=JSON.stringify(buildReplyContext('chapter-two','What should we do now?',[],{state,recentTurns:[],purpose:'conversation'}));
    expect(context).not.toContain('cooperate:ferry-plan:water-tower:passengers');
    expect(context).not.toContain('memoryIds');
  });
  it.each(['signal','return'] as const)('the complete %s route has witnessed progress and required cooperative events',ending=>{
    let state=initialState({gameplayVersion:2});
    let plan:CooperationPlan={meeting:ending==='signal'?'water-tower':'shelter',priority:ending==='signal'?'signal':'passengers',reason:'Keep our agreed priority in mind.'};
    for(let i=0;i<60&&!story[state.sceneId]?.ending;i++){
      if(needsCooperation(state)&&!cooperationComplete(state)){
        let option=cooperationOptions(state,plan)[0];
        if(!option){plan={...plan,meeting:'shelter'};option=cooperationOptions(state,plan)[0];}
        expect(option).toBeTruthy();state=commitCooperation(state,option!,[crypto.randomUUID()]);
      }
      const scene=story[state.sceneId]!;
      const action=scene.next?'continue':scene.choices.find(choice=>transition(state,{choiceId:choice.id,expectedVersion:state.version,clientActionId:'probe'}).ok)?.id;
      expect(action).toBeTruthy();const next=transition(state,{choiceId:action!,expectedVersion:state.version,clientActionId:crypto.randomUUID()});
      expect(next.ok).toBe(true);if(!next.ok)throw new Error(next.error);state=next.state;
    }
    expect(story[state.sceneId]?.ending).toBe(ending);
    expect(state.cooperation?.length).toBeGreaterThanOrEqual(4);
    expect(state.version).toBe(state.history.length+state.cooperation!.length);
    expect(witnessedScenes(state).at(-1)?.id).toBe(state.sceneId);
  });
});
