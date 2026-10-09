import {test,expect,type Page} from '@playwright/test';
import {initialState,story} from '../../src/game/story';
import {cooperationOptions,commitCooperation,commitPresentAgreement,type CooperationPlan,type CooperationOption} from '../../src/game/cooperation';
import {transition} from '../../src/game/reducer';
import {gotoGame,finishChapterCard,revealDialogue,continueStory} from './helpers';

async function fixture(page:Page,start='chapter-two',withReturn=false){
 page.on('pageerror',error=>console.log('Cooperation browser error:',error.message));
 let state={...initialState({gameplayVersion:2}),sceneId:start,version:12,flags:['survey-complete','station-reached','signal-inspected','warning-selected','return-chosen','passengers-accounted'],inventory:['coast-map','passenger-list'],unlockedChapters:[1,2,3]};
 if(start==='ferry-first')state=initialState({gameplayVersion:2});
 if(withReturn)state={...state,history:['promise-meet','continue:first-pause'],flags:[...state.flags,'made-meeting-plan'],cooperation:[{sceneId:'ferry-rendezvous',actionId:'witnessed-return',memoryIds:[crypto.randomUUID()],version:5,allowedChoices:['promise-meet']}]};
 let plan:CooperationPlan|undefined;let confirmed=false;let unavailable=false;let pendingPolls=0;
 const calls:string[]=[];
 const requests:Array<{path:string;body:Record<string,string>}>=[];
 let loseActionReply=false;const actionResults=new Map<string,unknown>();
 const proposals=new Map<string,CooperationOption>();
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(!path.startsWith('/api/'))return route.fallback();
  const body=route.request().method()==='POST'?route.request().postDataJSON():{};
  calls.push(path);
  requests.push({path,body});
  if(['/api/game','/api/session'].includes(path))return route.fulfill({json:{state,availability:{llm:false,memory:true,durableSave:true,reasons:[]}}});
  if(path==='/api/onboarding')return route.fulfill({json:{named:true,status:'confirmed',verified:true}});
  if(path==='/api/cooperation')return route.fulfill({json:{status:confirmed?(pendingPolls-->0?'pending':'confirmed'):'empty',required:true,complete:!!state.cooperation?.some(event=>event.sceneId===state.sceneId&&event.allowedChoices?.length)}});
  if(path==='/api/cooperation/draft'){plan=body.plan;return route.fulfill({json:{draftId:crypto.randomUUID(),plan}});}
  if(path==='/api/cooperation/confirm'){confirmed=true;pendingPolls=1;state={...state,cooperation:(state.cooperation??[]).map(event=>event.sceneId===state.sceneId?{...event,allowedChoices:[]}:event)};return route.fulfill({json:{status:'pending',memoryId:crypto.randomUUID()}});}
  if(path==='/api/cooperation/rebuild'){const option=cooperationOptions(state,plan!)[0]!;state=commitPresentAgreement(state,option);return route.fulfill({json:{state,consequence:option.consequence+' This is a present agreement, not a recalled memory.',gesture:option.gesture}});}
  if(path==='/api/cooperation/propose'){
   if(unavailable)return route.fulfill({status:503,json:{error:'PLAN_UNAVAILABLE'}});
   const current=plan??{meeting:'shelter',priority:'passengers',reason:'Keep the waiting passengers together.'};
   if(story[state.sceneId]?.ending)return route.fulfill({json:{status:'coda',dialogue:'We brought them under cover together, as you asked.',plan:current,memoryIds:[crypto.randomUUID()]}});
   const alternatives=cooperationOptions(state,current);const option=body.preferredAction?alternatives.find(option=>option.id===body.preferredAction):alternatives[0];
   if(option)proposals.set(body.clientTurnId,option);
   return route.fulfill({json:option?{status:'proposed',proposalId:body.clientTurnId,dialogue:`You asked us to ${current.priority==='passengers'?'help the passengers':'warn the boats'} first. Shall we carry out our plan?`,plan:current,option,alternatives,memoryIds:[crypto.randomUUID()]}:{status:'revise',plan:current,reason:'The flooded landing requires a shelter meeting now.'}});
  }
  if(path==='/api/cooperation/action'){
   if(actionResults.has(body.clientActionId))return route.fulfill({json:actionResults.get(body.clientActionId)});
   const option=proposals.get(body.proposalId)??cooperationOptions(state,plan!)[0]!;
   state=commitCooperation(state,option,[crypto.randomUUID()]);
   const result={state,consequence:option.consequence,gesture:option.gesture};actionResults.set(body.clientActionId,result);
   if(loseActionReply){loseActionReply=false;return route.abort('failed');}
   return route.fulfill({json:result});
  }
  if(path==='/api/actions'){
   const result=transition(state,body);if(!result.ok)return route.fulfill({status:422,json:{error:result.error}});
   state=result.state;return route.fulfill({json:{state}});
  }
  if(path==='/api/memories')return route.fulfill({json:{jobs:[]}});
  return route.fulfill({status:503,json:{error:'NOT_IN_FIXTURE'}});
 });
 return {calls,requests,failRecall:()=>{unavailable=true;},recoverRecall:()=>{unavailable=false;},loseNextActionReply:()=>{loseActionReply=true;},commits:()=>actionResults.size};
}
async function agree(page:Page,priority='passengers'){
 await expect(page.getByRole('region',{name:'Our shared plan'})).toBeVisible();
 await page.getByLabel('What comes first?').selectOption(priority);
 await page.getByLabel('Tell Mira why this matters to you').fill('Keep the waiting passengers together.');
 await page.getByRole('button',{name:'REVIEW OUR PLAN'}).click();
 await expect(page.getByText('This is your draft. Confirm before Mira stores it.')).toBeVisible();
 await page.getByRole('button',{name:'CONFIRM & REMEMBER'}).click();
 await expect(page.getByRole('button',{name:/AGREE ·/})).toBeVisible({timeout:15000});
}
test('a player-taught call-and-answer cue changes the rescue and can be agreed without remote storage',async({page})=>{
 const f=await fixture(page,'return-call');f.failRecall();await gotoGame(page);
 await page.getByLabel('Teach Mira how to coordinate').selectOption('call-response');
 await page.getByLabel('Your shared cue').fill('Blue lantern');
 await page.getByLabel('Tell Mira why this matters to you').fill('My brother needs to hear his own name.');
 await page.getByRole('button',{name:'REVIEW OUR PLAN'}).click();
 await expect(page.getByText('Call and wait for an answer, using “Blue lantern”.')).toBeVisible();
 await page.screenshot({path:'verification/visual/memory-soul-taught-method.png'});
 await page.getByRole('button',{name:'AGREE ON THIS STEP NOW'}).click();
 await expect(page.getByRole('status').filter({hasText:'answer their own name'})).toBeVisible();
 await expect(page.getByLabel('Your shared cue')).toHaveCount(0);
 await revealDialogue(page);await expect(page.getByRole('button',{name:'Call from the high steps and point out the route.'})).toBeEnabled();
 expect(f.calls).not.toContain('/api/cooperation/confirm');expect(f.calls).not.toContain('/api/cooperation/propose');
});
test('player selects a recalled route review and sees preparation before committing',async({page})=>{
 const f=await fixture(page,'chapter-two',true);await gotoGame(page);await agree(page,'signal');
 await page.getByRole('button',{name:'Consider: Compare our marked route together before the station'}).click();
 await expect(page.getByLabel('What Mira will prepare')).toContainText('joint route review');expect(f.commits()).toBe(0);
 const proposals=f.requests.filter(request=>request.path==='/api/cooperation/propose');expect(proposals).toHaveLength(2);expect(proposals[1].body.clientTurnId).not.toBe(proposals[0].body.clientTurnId);expect(proposals[1].body.preferredAction).toContain(':review');
 await page.getByRole('button',{name:/AGREE · Compare our marked route/}).click();await revealDialogue(page);
 await expect(page.getByRole('button',{name:'First check the route we marked.'})).toBeVisible();expect(f.commits()).toBe(1);
});
test('shared plan is confirmed, recalled proactively, challenged, and changes the next playable action',async({page})=>{
 const f=await fixture(page);await page.setViewportSize({width:1672,height:941});await gotoGame(page);await agree(page);
 await expect(page.getByLabel('What Mira will prepare')).toContainText('If you confirm');
 expect(f.commits()).toBe(0);
 await page.getByRole('button',{name:'Why this plan?'}).click();await expect(page.getByText(/Our checked agreement:/)).toBeVisible();
 await page.getByRole('button',{name:'Look at the situation'}).click();await expect(page.getByText(/What we can see now:/)).toBeVisible();
 expect(f.calls.filter(path=>path==='/api/cooperation/propose')).toHaveLength(1);
 await page.getByRole('button',{name:/AGREE ·/}).click();
 await expect(page.getByRole('status').filter({hasText:/Mira marks the gathering/})).toBeVisible();
 await revealDialogue(page);await expect(page.getByRole('button',{name:'The path is flooding. We should bring people back.'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Let’s reach the signal room together.'})).toHaveCount(0);
 await page.screenshot({path:'verification/visual/memory-core-desktop.png'});
 await page.getByRole('button',{name:'The path is flooding. We should bring people back.'}).click();await finishChapterCard(page);
 await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','return-call');
});
test('unavailable recall keeps plan and scene; retry succeeds on mobile',async({page})=>{
 const f=await fixture(page);f.failRecall();await page.setViewportSize({width:390,height:844});await gotoGame(page);
 await page.getByLabel('Tell Mira why this matters to you').fill('Warn the boats before the harbor gets dark.');
 await page.getByLabel('What comes first?').selectOption('signal');
 await page.getByRole('button',{name:'REVIEW OUR PLAN'}).click();await page.getByRole('button',{name:'CONFIRM & REMEMBER'}).click();
 await expect(page.getByRole('button',{name:'Try recalling again'})).toBeVisible({timeout:15000});
 await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','chapter-two');
 await expect(page.getByRole('button',{name:/AGREE ·/})).toHaveCount(0);
 f.recoverRecall();await page.getByRole('button',{name:'Try recalling again'}).click();await expect(page.getByRole('button',{name:/AGREE ·/})).toBeVisible();
 await page.screenshot({path:'verification/visual/memory-core-mobile.png'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('lost committed action response retries the same step without duplicate progress or reload',async({page})=>{
 const f=await fixture(page);await gotoGame(page);await agree(page);f.loseNextActionReply();
 await page.getByRole('button',{name:/AGREE ·/}).click();
 await expect(page.getByRole('button',{name:'CHECK THE SAME STEP'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Revise our plan'})).toBeDisabled();
 await page.getByRole('button',{name:'CHECK THE SAME STEP'}).click();
 await expect(page.getByRole('status').filter({hasText:/Mira marks the gathering/})).toBeVisible();
 expect(f.commits()).toBe(1);expect(f.calls.filter(path=>path==='/api/cooperation/action')).toHaveLength(2);
 await revealDialogue(page);await expect(page.getByRole('button',{name:'The path is flooding. We should bring people back.'})).toBeEnabled();
});

test('revising in the same scene rotates both IDs and changes the unlocked physical choice',async({page})=>{
 const f=await fixture(page);await gotoGame(page);await agree(page);
 await page.getByRole('button',{name:/AGREE ·/}).click();await expect(page.getByRole('button',{name:/AGREE ·/})).toHaveCount(0);
 await page.getByRole('button',{name:'Revise our plan'}).click();await page.getByLabel('What comes first?').selectOption('signal');
 await page.getByLabel('Tell Mira why this matters to you').fill('Warn the boats before the passenger handoff.');
 await page.getByRole('button',{name:'REVIEW OUR PLAN'}).click();await page.getByRole('button',{name:'CONFIRM & REMEMBER'}).click();
 await expect(page.getByRole('button',{name:/AGREE ·/})).toBeVisible({timeout:15000});await page.getByRole('button',{name:/AGREE ·/}).click();
 await expect(page.getByRole('button',{name:/AGREE ·/})).toHaveCount(0);
 const proposals=f.requests.filter(r=>r.path==='/api/cooperation/propose');const actions=f.requests.filter(r=>r.path==='/api/cooperation/action');
 expect(proposals).toHaveLength(2);expect(actions).toHaveLength(2);
 expect(proposals[0].body.clientTurnId).not.toBe(proposals[1].body.clientTurnId);expect(actions[0].body.clientActionId).not.toBe(actions[1].body.clientActionId);
 await revealDialogue(page);await expect(page.getByRole('button',{name:'Let’s reach the signal room together.'})).toBeVisible();await expect(page.getByRole('button',{name:'The path is flooding. We should bring people back.'})).toHaveCount(0);
});

for(const ending of ['signal','return'] as const)test(`new v2 crossing plays all three chapters to ${ending} through the cooperation controls`,async({page})=>{
 test.setTimeout(90000);const f=await fixture(page,'ferry-first');await gotoGame(page);
 for(let i=0;i<60;i++){
  const sceneId=(await page.locator('.scene-art').getAttribute('data-scene'))!;
  if(story[sceneId]?.ending){await revealDialogue(page);await expect(page.locator('.ending-seal')).toContainText(ending==='signal'?'SIGNAL RESTORED':'SAFE RETURN');expect(f.commits()).toBeGreaterThanOrEqual(4);return;}
  if(sceneId==='ferry-plan')await agree(page,ending==='signal'?'signal':'passengers');
  const agreeButton=page.getByRole('button',{name:/AGREE ·/});
  if(['ferry-plan','ferry-rendezvous','chapter-two','route-review','signal-tested','signal-room','return-call','return-plan'].includes(sceneId)){
   await expect(agreeButton).toBeVisible({timeout:15000});await agreeButton.click();await expect(agreeButton).toHaveCount(0);
  }
  await revealDialogue(page);
  if(story[sceneId]?.next)await continueStory(page,story[sceneId]!.next);else{await page.locator('.suggestions .suggestion').first().click();await expect(page.locator('.scene-art')).not.toHaveAttribute('data-scene',sceneId);await finishChapterCard(page);}
 }
 throw new Error('V2 ending was not reached');
});
