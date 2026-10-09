import {test,expect} from 'vitest';
import {validatePersonalAttribution,validateSceneActors} from '../../server/chat/personal-attribution';
test.each(['My sister needs to answer her own name.','I know my brother freezes.','Em gái của tôi cần được gọi tên.'])('rejects player-to-Mira biography reversal: %s',text=>expect(()=>validatePersonalAttribution(text)).toThrow('GROUNDING_REVERSED_RELATIONSHIP'));
test('preserves ownership when reflecting on the player reason',()=>expect(()=>validatePersonalAttribution('Your sister needs to answer her own name. Copper sparrow can be our reminder.')).not.toThrow());
test('the key-fetching role belongs to Mira at the separation scene',()=>{
 expect(()=>validateSceneActors('ferry-rendezvous',"You're fetching the station key while I check the landing.")).toThrow('GROUNDING_REVERSED_SCENE_ROLES');
 expect(()=>validateSceneActors('ferry-rendezvous',"I'll fetch the station key while you check the landing.")).not.toThrow();
});

test('does not confuse a second-person clause with Mira fetching the key',()=>{
 expect(()=>validateSceneActors('ferry-rendezvous',"I'll get the key; you check the landing.")).not.toThrow();
});
