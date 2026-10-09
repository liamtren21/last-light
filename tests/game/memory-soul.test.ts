import {expect,test} from 'vitest';
import {initialState,availableChoices} from '../../src/game/story';
import {cooperationPlanSchema,cooperationOptions,commitPresentAgreement,personalClosing} from '../../src/game/cooperation';
const plan={meeting:'shelter' as const,priority:'passengers' as const,reason:'My brother gets left behind in a crowd.',cue:'Blue lantern'};
test('a taught technique changes the physical rescue, not just a button label',()=>{
 const state={...initialState({gameplayVersion:2}),sceneId:'return-call',flags:['return-chosen']};
 const pairs=cooperationOptions(state,{...plan,technique:'pair-check'})[0]!;
 const answers=cooperationOptions(state,{...plan,technique:'call-response'})[0]!;
 expect(pairs.allowedChoices).toEqual(['escort-pairs']);expect(answers.allowedChoices).toEqual(['call-from-steps']);
 expect(pairs.consequence).toContain('Each pair must answer together');expect(answers.consequence).toContain('answer their own name');
 expect(pairs.consequence).toContain('Blue lantern');
});
test('an episode introduces a new actionable route even for a passenger-first plan',()=>{
 const state={...initialState({gameplayVersion:2}),sceneId:'chapter-two',flags:['survey-complete']};
 expect(cooperationOptions(state,{...plan,technique:'pair-check'}).some(x=>x.id.endsWith(':episode-review'))).toBe(false);
 expect(cooperationOptions(state,{...plan,technique:'pair-check'},['Engine-confirmed recalled event: The player returned to Mira under the ferry shelter roof.']).at(-1)?.allowedChoices).toEqual(['keep-promise']);
});
test('present consent allows continued play without invented Walrus evidence or private text in state',()=>{
 const state={...initialState({gameplayVersion:2}),sceneId:'return-call',flags:['return-chosen']};
 const option=cooperationOptions(state,{...plan,technique:'call-response'})[0]!;
 const next=commitPresentAgreement(state,option);
 expect(availableChoices(next).map(x=>x.id)).toEqual(['call-from-steps']);
 expect(next.cooperation?.at(-1)?.memoryIds).toEqual([]);
 expect(JSON.stringify(next)).not.toContain(plan.cue);expect(JSON.stringify(next)).not.toContain(plan.reason);
});
test('the personal closing gesture depends on a completed outcome and the exact taught cue',()=>{
 const state={...initialState({gameplayVersion:2}),sceneId:'ending-return',completedEndings:['return' as const],flags:['passengers-accounted']};
 expect(personalClosing(state,{...plan,technique:'pair-check'})).toContain('Blue lantern');
 expect(personalClosing({...state,flags:[]},{...plan,technique:'pair-check'})).toBe('');
 expect(personalClosing(state,{meeting:'shelter',priority:'passengers',reason:'Stay together'})).toBe('');
});
test('legacy plans remain valid but a partial taught method does not',()=>{
 expect(cooperationPlanSchema.safeParse({meeting:'shelter',priority:'passengers',reason:'Stay together'}).success).toBe(true);
 expect(cooperationPlanSchema.safeParse({...plan}).success).toBe(false);
});
