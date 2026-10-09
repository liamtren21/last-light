import {describe,it,expect} from 'vitest';
import {initialState} from '../../src/game/story';
import {restoreGameState} from '../../src/game/save';
import {transition} from '../../src/game/reducer';
import {cooperationOptions,commitCooperation} from '../../src/game/cooperation';
describe('memory mode boundaries',()=>{
 it('retains legacy saves and explicitly versions new games',()=>{
  expect(restoreGameState(initialState()).gameplayVersion).toBeUndefined();
  expect(restoreGameState(initialState({gameplayVersion:2})).gameplayVersion).toBe(2);
 });
 it.each(['ferry-plan','ferry-rendezvous','chapter-two','signal-room','return-call','return-plan'])('blocks ordinary choices at %s without cooperation',sceneId=>{
  const state={...initialState({gameplayVersion:2}),sceneId,flags:['survey-complete','signal-inspected','warning-selected','return-chosen','passengers-accounted']};
  const id=({ 'ferry-plan':'ridge-route','ferry-rendezvous':'promise-meet','chapter-two':'try-tower','signal-room':'restore-signal','return-call':'escort-pairs','return-plan':'keep-watch'} as Record<string,string>)[sceneId]!;
  expect(transition(state,{choiceId:id,expectedVersion:0,clientActionId:crypto.randomUUID()}).ok).toBe(false);
 });
 it('different plans provide different cooperative actions and committed consequences',()=>{
  const state={...initialState({gameplayVersion:2}),sceneId:'chapter-two'};
  const a=cooperationOptions(state,{meeting:'shelter',priority:'passengers',reason:'Nobody should be alone.'});
  const b=cooperationOptions(state,{meeting:'water-tower',priority:'signal',reason:'The boats need warning.'});
  expect(a[0]?.id).not.toBe(b[0]?.id);
  expect(commitCooperation(state,a[0]!,['memory-id']).cooperation?.at(-1)?.actionId).toMatch(/^cooperate:[0-9a-f-]+$/);
  expect(JSON.stringify(commitCooperation(state,a[0]!,['memory-id']))).not.toContain('Nobody');
 });
});
