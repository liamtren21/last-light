import {test,expect} from 'vitest';
import {initialState} from '../../src/game/story';
import {transition} from '../../src/game/reducer';
import {witnessedScenes} from '../../src/game/recap';
test('recap exposes only the actually chosen branch and never changes state',()=>{
  const result=transition(initialState(),{choiceId:'ask-map',expectedVersion:0,clientActionId:'recap-test'});if(!result.ok)throw new Error(result.error);
  const before=JSON.stringify(result.state);
  expect(witnessedScenes(result.state).map(s=>s.id)).toEqual(['ferry-first','ferry-map']);
  expect(JSON.stringify(result.state)).toBe(before);
});
test('unknown history does not guess a future scene',()=>{
  expect(witnessedScenes({...initialState(),sceneId:'signal-room',history:['unknown']})).toEqual([]);
});
test('a connected history that contradicts the saved flags fails closed',()=>{
  const result=transition(initialState(),{choiceId:'ask-map',expectedVersion:0,clientActionId:'recap-test'});if(!result.ok)throw new Error(result.error);
  expect(witnessedScenes({...result.state,flags:[]})).toEqual([]);
  expect(witnessedScenes({...result.state,version:99})).toEqual([]);
});
