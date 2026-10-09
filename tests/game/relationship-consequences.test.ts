import {describe,expect,it} from 'vitest';
import {initialState} from '../../src/game/story';
import {cooperationOptions,commitCooperation,type CooperationPlan} from '../../src/game/cooperation';
import type {GameState} from '../../src/game/schema';
import {relationshipConsequences} from '../../src/game/relationship';
import {transition} from '../../src/game/reducer';
import {story} from '../../src/game/story';
import {needsCooperation,cooperationComplete} from '../../src/game/cooperation';

const plan:CooperationPlan={meeting:'shelter',priority:'signal',reason:'Warn the boats before the tide rises.'};
const event=(sceneId:string,allowedChoices:string[],version:number)=>({sceneId,allowedChoices,version,actionId:`cooperate:${crypto.randomUUID()}`,memoryIds:[crypto.randomUUID()]});
function state(sceneId:string):GameState{return {...initialState({gameplayVersion:2}),sceneId,version:20,flags:['survey-complete','made-meeting-plan','return-chosen'],inventory:['coast-map','passenger-list']};}
const returned=():GameState=>({...state('chapter-two'),history:['promise-meet','continue:first-pause'],cooperation:[event('ferry-rendezvous',['promise-meet'],8)]});
const interrupted=():GameState=>({...state('return-call'),history:['try-tower','turn-back','continue:return-descent'],cooperation:[event('chapter-two',['try-tower'],12)]});

describe('observed relationship consequences',()=>{
 it('a fulfilled meeting opens a concrete joint route review before proceeding',()=>{
  const fresh=cooperationOptions(state('chapter-two'),plan);
  const kept=cooperationOptions(returned(),plan);
  expect(fresh.flatMap(option=>option.allowedChoices)).not.toContain('keep-promise');
  expect(kept.flatMap(option=>option.allowedChoices)).toContain('keep-promise');
  expect(kept.find(option=>option.allowedChoices.includes('keep-promise'))?.consequence).toContain('map');
 });
 it('interrupted signal work offers a passenger handoff repair without trapping the original choice',()=>{
  const options=cooperationOptions(interrupted(),plan);
  expect(options.flatMap(option=>option.allowedChoices)).toContain('call-from-steps');
  expect(options.flatMap(option=>option.allowedChoices)).toContain('escort-pairs');
  expect(options.find(option=>option.allowedChoices.includes('escort-pairs'))?.consequence).toContain('pairs');
 });
 it('correction or an unexecuted proposal never creates an interruption or a repair debt',()=>{
  const corrected={...state('return-call'),cooperation:[event('chapter-two',[],12)],history:['turn-back']};
  const pending={...state('return-call'),cooperation:[event('chapter-two',['try-tower'],12)],history:['turn-back']};
  expect(cooperationOptions(corrected,plan).flatMap(option=>option.allowedChoices)).toEqual(['call-from-steps']);
  expect(cooperationOptions(pending,plan).flatMap(option=>option.allowedChoices)).toEqual(['call-from-steps']);
 });
 it('committing a repair preparation stores only action evidence, never the remembered reason',()=>{
  const before=interrupted();const repair=cooperationOptions(before,plan).find(option=>option.allowedChoices.includes('escort-pairs'))!;
  expect(repair).toBeTruthy();const after=commitCooperation(before,repair,['verified-plan-memory']);
  expect(after.flags).toContain('cooperation-repair-prepared');
  expect(JSON.stringify(after)).not.toContain(plan.reason);
 });
 it('repair preparation does not claim execution or six passengers safe',()=>{
  const before=interrupted();const option=cooperationOptions(before,plan).find(option=>option.preparationKind==='repair-handoff')!;
  const prepared=commitCooperation(before,option,['verified-plan-memory']);
  expect(relationshipConsequences(prepared)).toMatchObject({status:'repairing',repairPrepared:true,repairCompleted:false});
  const action=transition(prepared,{choiceId:'escort-pairs',expectedVersion:prepared.version,clientActionId:crypto.randomUUID()});
  expect(action.ok).toBe(true);if(!action.ok)throw new Error(action.error);
  expect(relationshipConsequences(action.state)).toMatchObject({status:'repaired',repairCompleted:true});
  expect(relationshipConsequences(action.state).observations.at(-1)).toContain('only if');
 });
 it('does not infer a relationship from flags, unknown memory events, or a turn-back before the agreement',()=>{
  const forged={...interrupted(),history:['turn-back','try-tower'],flags:['return-chosen','cooperation-repair-prepared']};
  expect(relationshipConsequences(forged).signalInterrupted).toBe(false);
  expect(relationshipConsequences({...interrupted(),cooperation:[]}).status).toBe('unproven');
  expect(relationshipConsequences({...interrupted(),cooperation:[{...interrupted().cooperation![0]!,memoryIds:[]}]}).status).toBe('unproven');
  expect(relationshipConsequences({...interrupted(),cooperation:[event('chapter-two',['try-tower'],21)]}).status).toBe('unproven');
 });
 it('observations contain bounded physical history without identifiers or private reason text',()=>{
  const evidence=JSON.stringify(relationshipConsequences(interrupted()));
  expect(evidence).toContain('not evidence of dishonesty or betrayal');
  expect(evidence).not.toContain('memoryIds');
  expect(evidence).not.toContain(plan.reason);
 });
 it.each(['signal','return'] as const)('can finish %s through the additional review or repair path',ending=>{
  let current=initialState({gameplayVersion:2});let tookReview=false;let tookRepair=false;
  for(let turn=0;turn<60&&!story[current.sceneId]?.ending;turn++){
   const recalled={...plan,meeting:(['return-call','return-plan'].includes(current.sceneId)?'shelter':'water-tower') as CooperationPlan['meeting']};
   if(needsCooperation(current)&&!cooperationComplete(current)){
    const options=cooperationOptions(current,recalled);
    const option=current.sceneId==='chapter-two'?options.find(value=>value.preparationKind==='route-review')??options[0]:current.sceneId==='return-call'?options.find(value=>value.preparationKind==='repair-handoff')??options[0]:options[0];
    expect(option).toBeTruthy();tookReview ||=option!.preparationKind==='route-review';tookRepair ||=option!.preparationKind==='repair-handoff';
    expect(option!.preparation).toMatch(/^If you confirm,/);
    current=commitCooperation(current,option!,[crypto.randomUUID()]);
   }
   const scene=story[current.sceneId]!;
   const available=scene.choices.filter(choice=>transition(current,{choiceId:choice.id,expectedVersion:current.version,clientActionId:'probe'}).ok);
   const choiceId=ending==='return'&&current.sceneId==='tower-road'?'turn-back':scene.next?'continue':available[0]?.id;
   expect(choiceId).toBeTruthy();const result=transition(current,{choiceId:choiceId!,expectedVersion:current.version,clientActionId:crypto.randomUUID()});
   expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);current=result.state;
  }
  expect(story[current.sceneId]?.ending).toBe(ending);expect(tookReview).toBe(true);
  if(ending==='return'){expect(tookRepair).toBe(true);expect(relationshipConsequences(current).status).toBe('repaired');}
 });
});
