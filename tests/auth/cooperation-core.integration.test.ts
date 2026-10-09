import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
const transport=vi.hoisted(()=>({recall:vi.fn(),destroy:vi.fn()}));
const provider=vi.hoisted(()=>({reply:vi.fn(),extract:vi.fn()}));
vi.mock('../../server/llm/gemini',()=>({generateMiraReply:provider.reply,proposeMiraMemory:provider.extract}));
vi.mock('../../server/memory/adapter',async original=>({...await original<object>(),createMemWal:()=>transport}));
import {app} from '../../server/index';
import {pool,migrate} from '../../server/db';
import {initialState,story} from '../../src/game/story';
import {transition} from '../../src/game/reducer';
import {needsCooperation,cooperationComplete} from '../../src/game/cooperation';
import {decryptPayload} from '../../server/memory/crypto';
import {checksum} from '../../server/memory/adapter';
import {factHash,opaqueNamespace} from '../../server/memory/scope';
import type {CooperationPlan} from '../../src/game/cooperation';

const post=(path:string,cookie:string,body:unknown)=>app.request(path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
const reason='Unique player reason: keep the twins together by the dry ferry gate.';
const plan:CooperationPlan={meeting:'shelter',priority:'passengers',reason};
const remote=new Map<string,{blob_id:string;text:string}>();

describe.skipIf(!process.env.LAST_LIGHT_DATABASE_TEST)('independent memory-core API acceptance (simulated Walrus, real PostgreSQL)',()=>{
 beforeAll(async()=>{await migrate();});
 afterAll(async()=>{await pool?.end();});
 afterEach(()=>vi.restoreAllMocks());
 beforeEach(()=>{
  vi.resetAllMocks();remote.clear();
  transport.recall.mockImplementation(async({namespace}:{namespace:string})=>({results:remote.has(namespace)?[remote.get(namespace)!]:[]}));
  provider.reply.mockImplementation(async(_scene:string,_message:string,_facts:string[],context:{cooperation?:{allowedActions:string[]}})=>({dialogue:'You asked us to help the passengers first. Shall we carry out that plan?',expression:'attentive',proposedAction:context.cooperation?.allowedActions[0]??null}));
 });
 async function session(){
  const response=await post('/api/session','',{});expect(response.status).toBe(200);
  const cookie=response.headers.get('set-cookie')!.split(';')[0]!;
  const token=decodeURIComponent(cookie.slice(cookie.indexOf('=')+1));
  const row=(await pool!.query('SELECT user_id,campaign_id FROM sessions WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')])).rows[0];
  expect(row).toBeTruthy();
  const state={...initialState(),gameplayVersion:2,sceneId:'chapter-two',version:12,flags:['survey-complete'],inventory:['coast-map','passenger-list'],unlockedChapters:[1,2]};
  await pool!.query('UPDATE campaigns SET game_state=$2,version=12 WHERE id=$1',[row.campaign_id,state]);
  return {cookie,campaignId:row.campaign_id as string,userId:row.user_id as string};
 }
 it('confirmed present-scene rebuilding survives remote outage without fabricating a receipt and cannot be reused as a saved draft',async()=>{
  const s=await session();transport.recall.mockRejectedValue(new Error('fixture outage'));
  const draftResponse=await post('/api/cooperation/draft',s.cookie,{plan:{...plan,technique:'pair-check',cue:'Blue lantern'},expectedVersion:12,clientTurnId:crypto.randomUUID()});
  expect(draftResponse.status).toBe(200);const draft=await draftResponse.json();
  const response=await post('/api/cooperation/rebuild',s.cookie,{draftId:draft.draftId,expectedVersion:12});expect(response.status).toBe(200);
  const result=await response.json();expect(result.state.version).toBe(13);expect(result.memoryIds).toEqual([]);expect(JSON.stringify(result.state)).not.toContain('Blue lantern');
  const replay=await post('/api/cooperation/rebuild',s.cookie,{draftId:draft.draftId,expectedVersion:12});expect(replay.status).toBe(200);expect((await replay.json()).state).toEqual(result.state);
  expect((await post('/api/cooperation/confirm',s.cookie,{draftId:draft.draftId,expectedVersion:13})).status).toBe(409);
  expect((await pool!.query('SELECT memory_id FROM memory_outbox WHERE campaign_id=$1',[s.campaignId])).rowCount).toBe(0);
 });
 async function confirm(s:Awaited<ReturnType<typeof session>>,value=plan,expectedVersion=12){
  const draftResponse=await post('/api/cooperation/draft',s.cookie,{plan:value,expectedVersion,clientTurnId:crypto.randomUUID()});
  expect(draftResponse.status).toBe(200);const draft=await draftResponse.json();
  const response=await post('/api/cooperation/confirm',s.cookie,{draftId:draft.draftId,expectedVersion});
  expect(response.status).toBe(200);return response.json() as Promise<{memoryId:string;status:string}>;
 }
 async function activate(s:Awaited<ReturnType<typeof session>>,memoryId:string,expiresAt?:string){
  const row=(await pool!.query('SELECT * FROM memory_outbox WHERE memory_id=$1',[memoryId])).rows[0];
  expect(row).toBeTruthy();expect(row.payload_ciphertext).not.toContain(reason);
  const parsed=JSON.parse(decryptPayload(row.payload_ciphertext));if(expiresAt)parsed.expiresAt=expiresAt;const text=JSON.stringify(parsed);
  expect(parsed.cooperation).toBeTruthy();const blobId=`fixture-blob-${memoryId}`;
  remote.set(row.namespace,{blob_id:blobId,text});
  await pool!.query("UPDATE memory_outbox SET status='confirmed',payload_ciphertext='',blob_id=$2 WHERE memory_id=$1",[memoryId,blobId]);
  await pool!.query('INSERT INTO memory_receipts(memory_id,job_id,blob_id,checksum,recall_verified_at) VALUES($1,$2,$3,$4,now())',[memoryId,`fixture-job-${memoryId}`,blobId,checksum(text)]);
  await pool!.query('UPDATE fact_heads SET active_revision=$3,active_memory_id=$4,pending_revision=NULL WHERE campaign_id=$1 AND fact_key_hash=$2',[s.campaignId,factHash('cooperation.plan'),row.revision,memoryId]);
  return {row,parsed};
 }
 async function propose(s:Awaited<ReturnType<typeof session>>){
  const response=await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId:crypto.randomUUID()});
  expect(response.status).toBe(200);return response.json();
 }
 it('a remotely recalled episode changes an executable plan and forgetting it invalidates the proposal',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);
  const memoryId=crypto.randomUUID(),key=`episode.${memoryId}`,namespace=opaqueNamespace(s.userId,s.campaignId),blobId=`fixture-episode-${memoryId}`;
  const text=JSON.stringify({schemaVersion:1,memoryId,campaignId:s.campaignId,characterId:'mira',kind:'episode',factKey:key,revision:1,text:'After making a meeting plan, the player returned to Mira under the ferry shelter roof. They reunited after waiting out the squall.',source:{type:'game',id:crypto.randomUUID()},occurredAt:new Date().toISOString()});
  remote.set(namespace,{blob_id:blobId,text});
  await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,namespace,payload_ciphertext,fact_key_hash,revision,status,memory_kind,blob_id) VALUES($1,$2,$3,'mira',$4,'',$5,1,'confirmed','episode',$6)",[memoryId,s.userId,s.campaignId,namespace,factHash(key),blobId]);
  await pool!.query('INSERT INTO memory_receipts(memory_id,job_id,blob_id,checksum,recall_verified_at) VALUES($1,$2,$3,$4,now())',[memoryId,`fixture-job-${memoryId}`,blobId,checksum(text)]);
  await pool!.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,active_memory_id) VALUES($1,'mira',$2,1,$3)",[s.campaignId,factHash(key),memoryId]);
  const first=await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId:crypto.randomUUID(),preferredAction:'cooperate:chapter-two:shelter:passengers:episode-review'});expect(first.status).toBe(200);
  const proposed=await first.json();expect(proposed.option.allowedChoices).toEqual(['keep-promise']);expect(proposed.episodeEvidence.memoryIds).toContain(memoryId);
  const storedProposal=(await pool!.query('SELECT episode_ids FROM cooperation_proposals WHERE campaign_id=$1 AND id=$2',[s.campaignId,proposed.proposalId])).rows[0];expect(storedProposal.episode_ids).toEqual([memoryId]);
  expect((await post('/api/memories/forget',s.cookie,{memoryId})).status).toBe(200);
  expect((await post('/api/cooperation/action',s.cookie,{proposalId:proposed.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()})).status).toBe(409);
 });
 it('player can request a witnessed route review and retry preserves the bound action',async()=>{
  const s=await session();const saved=await confirm(s,{...plan,priority:'signal'});await activate(s,saved.memoryId);
  const state={...initialState({gameplayVersion:2}),sceneId:'chapter-two',version:12,flags:['survey-complete','made-meeting-plan'],history:['promise-meet','continue:first-pause'],inventory:['coast-map','passenger-list'],unlockedChapters:[1,2],cooperation:[{sceneId:'ferry-rendezvous',actionId:'witnessed',memoryIds:[saved.memoryId],version:5,allowedChoices:['promise-meet']}]};
  await pool!.query('UPDATE campaigns SET game_state=$2 WHERE id=$1',[s.campaignId,state]);
  const clientTurnId=crypto.randomUUID();const preferredAction='cooperate:chapter-two:shelter:signal:review';
  const body={expectedVersion:12,clientTurnId,preferredAction};
  const first=await post('/api/cooperation/propose',s.cookie,body);expect(first.status).toBe(200);const proposal=await first.json();
  expect(proposal.option.id).toBe(preferredAction);expect(proposal.alternatives).toHaveLength(2);
  expect((await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId})).status).toBe(200);
  expect(provider.reply.mock.calls.at(-1)?.[3].cooperation.allowedActions).toEqual([preferredAction]);
  expect((await post('/api/cooperation/propose',s.cookie,{...body,preferredAction:'cooperate:chapter-two:shelter:signal'})).status).toBe(409);
  expect((await post('/api/cooperation/propose',s.cookie,{...body,clientTurnId:crypto.randomUUID(),preferredAction:'forged'})).status).toBe(422);
  const result=await post('/api/cooperation/action',s.cookie,{proposalId:clientTurnId,expectedVersion:12,clientActionId:crypto.randomUUID()});expect(result.status).toBe(200);
  expect((await result.json()).state.cooperation.at(-1).allowedChoices).toEqual(['keep-promise']);
 });
 it('rejects unauthenticated and forged proposal requests without game progress',async()=>{
  expect((await post('/api/cooperation/draft','',{plan,expectedVersion:12,clientTurnId:crypto.randomUUID()})).status).toBe(401);
  const s=await session();
  expect((await post('/api/cooperation/action',s.cookie,{proposalId:crypto.randomUUID(),expectedVersion:12,clientActionId:crypto.randomUUID()})).status).toBeGreaterThanOrEqual(400);
  expect((await (await app.request('/api/game',{headers:{cookie:s.cookie}})).json()).state.version).toBe(12);
 });
 it('requires remote plan, commits one result on retry, and keeps personal reason out of game storage',async()=>{
  const s=await session();const saved=await confirm(s);
  expect((await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId:crypto.randomUUID()})).status).toBeGreaterThanOrEqual(400);
  await activate(s,saved.memoryId);const proposal=await propose(s);
  const body={proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()};
  const result=await post('/api/cooperation/action',s.cookie,body);expect(result.status).toBe(200);
  const completed=await result.json();expect(completed.state.version).toBeGreaterThan(12);
  const retry=await post('/api/cooperation/action',s.cookie,body);expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject(completed);
  const events=await pool!.query('SELECT payload FROM game_events WHERE campaign_id=$1 AND id=$2',[s.campaignId,body.clientActionId]);expect(events.rowCount).toBe(1);
  expect(JSON.stringify(events.rows)).not.toContain(reason);
  const state=(await pool!.query('SELECT game_state FROM campaigns WHERE id=$1',[s.campaignId])).rows[0];expect(JSON.stringify(state)).not.toContain(reason);
  expect(transport.recall).toHaveBeenCalled();
 });
 it('pending correction suppresses an already issued proposal and does not advance the story',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);const proposal=await propose(s);
  await confirm(s,{...plan,priority:'signal',reason:'Now warn the boats first.'});
  const response=await post('/api/cooperation/action',s.cookie,{proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()});expect(response.status).toBeGreaterThanOrEqual(400);
  expect((await (await app.request('/api/game',{headers:{cookie:s.cookie}})).json()).state.version).toBe(12);
 });
 it('another campaign cannot use a valid proposal even with its own ready plan',async()=>{
  const first=await session();const a=await confirm(first);await activate(first,a.memoryId);const proposal=await propose(first);
  const second=await session();const b=await confirm(second);await activate(second,b.memoryId);
  const response=await post('/api/cooperation/action',second.cookie,{proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()});expect(response.status).toBeGreaterThanOrEqual(400);
 });
 it('forget blocks old proposal; explicit rebuild creates a newer suppressed pending revision',async()=>{
  const s=await session();const saved=await confirm(s);const previous=await activate(s,saved.memoryId);const proposal=await propose(s);
  expect((await post('/api/memories/forget',s.cookie,{memoryId:saved.memoryId})).status).toBe(200);
  expect((await post('/api/cooperation/action',s.cookie,{proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()})).status).toBeGreaterThanOrEqual(400);
  const rebuilt=await confirm(s,{...plan,reason:'We agree on a new plan after forgetting.'});
  const head=(await pool!.query('SELECT pending_revision FROM fact_heads WHERE campaign_id=$1 AND fact_key_hash=$2',[s.campaignId,factHash('cooperation.plan')])).rows[0];expect(head.pending_revision).toBeGreaterThan(previous.row.revision);
  expect(rebuilt.memoryId).not.toBe(saved.memoryId);
  expect((await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId:crypto.randomUUID()})).status).toBeGreaterThanOrEqual(400);
 });
 it('identical successful action retries survive forget and outage; another proposal cannot reuse the action ID',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);const proposal=await propose(s);
  const body={proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()};
  const first=await post('/api/cooperation/action',s.cookie,body);expect(first.status).toBe(200);const result=await first.json();
  await post('/api/memories/forget',s.cookie,{memoryId:saved.memoryId});transport.recall.mockRejectedValue(new Error('fixture outage'));
  const retry=await post('/api/cooperation/action',s.cookie,body);expect(retry.status).toBe(200);expect(await retry.json()).toEqual(result);
  expect((await post('/api/cooperation/action',s.cookie,{...body,proposalId:crypto.randomUUID()})).status).toBe(409);
 });
 it('expiry between cooperation and physical action prevents the ending/route transition',async()=>{
  const s=await session();const saved=await confirm(s);const now=Date.now();await activate(s,saved.memoryId,new Date(now+60000).toISOString());
  const proposal=await propose(s);const action=await post('/api/cooperation/action',s.cookie,{proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()});expect(action.status).toBe(200);const completed=await action.json();
  vi.spyOn(Date,'now').mockReturnValue(now+120000);
  const physical=await post('/api/actions',s.cookie,{choiceId:'safe-return',expectedVersion:completed.state.version,clientActionId:crypto.randomUUID()});expect(physical.status).toBe(422);
  expect((await (await app.request('/api/game',{headers:{cookie:s.cookie}})).json()).state.version).toBe(completed.state.version);
 });
 it('replaying a confirmed draft is a controlled error rather than decrypting purged ciphertext',async()=>{
  const s=await session();const body={plan,expectedVersion:12,clientTurnId:crypto.randomUUID()};
  const draft=await (await post('/api/cooperation/draft',s.cookie,body)).json();
  expect((await post('/api/cooperation/confirm',s.cookie,{draftId:draft.draftId,expectedVersion:12})).status).toBe(200);
  expect((await post('/api/cooperation/draft',s.cookie,body)).status).toBe(409);
 });
 it('ending coda requires the plan actually used in the final cooperation, not just a currently active note',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);
  const state={...initialState({gameplayVersion:2}),sceneId:'ending-return',version:20,
   cooperation:[{sceneId:'return-plan',actionId:`cooperate:${crypto.randomUUID()}`,memoryIds:[saved.memoryId],version:19,allowedChoices:['keep-watch']}]};
  await pool!.query('UPDATE campaigns SET game_state=$2,version=20 WHERE id=$1',[s.campaignId,state]);
  const request=()=>post('/api/cooperation/propose',s.cookie,{expectedVersion:20,clientTurnId:crypto.randomUUID()});
  expect((await request()).status).toBe(200);expect(provider.reply).toHaveBeenCalledTimes(1);
  await pool!.query('UPDATE campaigns SET game_state=$2 WHERE id=$1',[s.campaignId,{...state,cooperation:[{...state.cooperation[0],memoryIds:[crypto.randomUUID()]}]}]);
  expect((await request()).status).toBe(503);expect(provider.reply).toHaveBeenCalledTimes(1);
 });
 it('a forget during closing dialogue generation suppresses that stale coda',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);
  const state={...initialState({gameplayVersion:2}),sceneId:'ending-return',version:20,
   cooperation:[{sceneId:'return-plan',actionId:`cooperate:${crypto.randomUUID()}`,memoryIds:[saved.memoryId],version:19,allowedChoices:['keep-watch']}]};
  await pool!.query('UPDATE campaigns SET game_state=$2,version=20 WHERE id=$1',[s.campaignId,state]);
  provider.reply.mockImplementationOnce(async()=>{
   expect((await post('/api/memories/forget',s.cookie,{memoryId:saved.memoryId})).status).toBe(200);
   return {dialogue:'We followed your plan.',expression:'relieved',proposedAction:null};
  });
  const response=await post('/api/cooperation/propose',s.cookie,{expectedVersion:20,clientTurnId:crypto.randomUUID()});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'PLAN_CHANGED'});
 });
 it('terminal worker failure is visible while the pending revision continues to suppress recall',async()=>{
  const s=await session();const saved=await confirm(s);
  await pool!.query("UPDATE memory_outbox SET status='failed' WHERE memory_id=$1",[saved.memoryId]);
  const status=await (await app.request('/api/cooperation',{headers:{cookie:s.cookie}})).json();
  expect(status.status).toBe('failed');expect((await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId:crypto.randomUUID()})).status).toBe(503);
 });
 it('a plan expiring during coda generation cannot be presented as current evidence',async()=>{
  const s=await session();const saved=await confirm(s);const now=Date.now();await activate(s,saved.memoryId,new Date(now+60000).toISOString());
  const state={...initialState({gameplayVersion:2}),sceneId:'ending-return',version:20,
   cooperation:[{sceneId:'return-plan',actionId:`cooperate:${crypto.randomUUID()}`,memoryIds:[saved.memoryId],version:19,allowedChoices:['keep-watch']}]};
  await pool!.query('UPDATE campaigns SET game_state=$2,version=20 WHERE id=$1',[s.campaignId,state]);
  provider.reply.mockImplementationOnce(async()=>{vi.spyOn(Date,'now').mockReturnValue(now+120000);return {dialogue:'We followed your plan.',expression:'relieved',proposedAction:null};});
  const response=await post('/api/cooperation/propose',s.cookie,{expectedVersion:20,clientTurnId:crypto.randomUUID()});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'PLAN_CHANGED'});
 });
 it.each(['signal','return','preserved-return'] as const)('HTTP execution crosses three chapters to the %s ending with scoped remote proofs',async ending=>{
  const s=await session();let state=initialState({gameplayVersion:2});
  await pool!.query('UPDATE campaigns SET game_state=$2,version=0 WHERE id=$1',[s.campaignId,state]);
  let agreement:CooperationPlan={meeting:ending==='return'?'shelter':'water-tower',priority:ending==='return'?'passengers':'signal',reason:'Keep our agreed priority in mind.'};
  let hasPlan=false;
  for(let i=0;i<60&&!story[state.sceneId]?.ending;i++){
   if(needsCooperation(state)&&!cooperationComplete(state)){
    if(!hasPlan){const saved=await confirm(s,agreement,state.version);await activate(s,saved.memoryId);hasPlan=true;}
    const proposeRequest=()=>post('/api/cooperation/propose',s.cookie,{expectedVersion:state.version,clientTurnId:crypto.randomUUID()});
    let proposed=await proposeRequest();expect(proposed.status).toBe(200);let proposal=await proposed.json();
    if(proposal.status==='revise'){agreement={...agreement,meeting:'shelter'};const saved=await confirm(s,agreement,state.version);await activate(s,saved.memoryId);proposed=await proposeRequest();expect(proposed.status).toBe(200);proposal=await proposed.json();}
    const committed=await post('/api/cooperation/action',s.cookie,{proposalId:proposal.proposalId,expectedVersion:state.version,clientActionId:crypto.randomUUID()});
    expect(committed.status).toBe(200);state=(await committed.json()).state;
   }
   const scene=story[state.sceneId]!;
   const choiceId=state.sceneId==='signal-room'&&ending==='preserved-return'?'save-charge':scene.next?'continue':scene.choices.find(choice=>transition(state,{choiceId:choice.id,expectedVersion:state.version,clientActionId:'probe'}).ok)?.id;
   expect(choiceId).toBeTruthy();const response=await post('/api/actions',s.cookie,{choiceId,expectedVersion:state.version,clientActionId:crypto.randomUUID()});
   expect(response.status).toBe(200);state=(await response.json()).state;
  }
  expect(story[state.sceneId]?.ending).toBe(ending==='signal'?'signal':'return');expect(state.unlockedChapters).toEqual([1,2,3]);expect(state.cooperation!.length).toBeGreaterThanOrEqual(4);
  const closing=await post('/api/cooperation/propose',s.cookie,{expectedVersion:state.version,clientTurnId:crypto.randomUUID()});expect(closing.status).toBe(200);expect((await closing.json()).status).toBe('coda');
 });
 it('forget committed after remote recall but before the action lock invalidates that in-flight proof',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);const proposal=await propose(s);
  const lock=await pool!.connect();let notify!:()=>void;const recalled=new Promise<void>(resolve=>notify=resolve);
  transport.recall.mockImplementationOnce(async({namespace}:{namespace:string})=>{notify();return {results:[remote.get(namespace)!]};});
  try{
   await lock.query('BEGIN');await lock.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE',[s.campaignId]);
   const action=post('/api/cooperation/action',s.cookie,{proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()});
   await recalled;
   await lock.query("INSERT INTO memory_tombstones(campaign_id,character_id,fact_key_hash,reason) VALUES($1,'mira',$2,'fixture synchronized forget')",[s.campaignId,factHash('cooperation.plan')]);
   await lock.query('COMMIT');expect((await action).status).toBe(409);
   expect((await (await app.request('/api/game',{headers:{cookie:s.cookie}})).json()).state.version).toBe(12);
  }finally{await lock.query('ROLLBACK');lock.release();}
 });
 it('twenty newer preferences do not crowd the exact required plan out of recall',async()=>{
  const s=await session();const saved=await confirm(s);const active=await activate(s,saved.memoryId);
  for(let i=0;i<20;i++){
   const id=crypto.randomUUID(),key=factHash(`preference.fixture.${i}`);
   await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,namespace,payload_ciphertext,fact_key_hash,revision,status,memory_kind) VALUES($1,$2,$3,'mira',$4,'',$5,1,'confirmed','preference')",[id,s.userId,s.campaignId,`fixture-preference-${id}`,key]);
   await pool!.query('INSERT INTO memory_receipts(memory_id,job_id,blob_id,checksum,recall_verified_at) VALUES($1,$2,$3,$4,now())',[id,`fixture-job-${id}`,`fixture-blob-${id}`,checksum('unrelated newer preference')]);
   await pool!.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,active_memory_id) VALUES($1,'mira',$2,1,$3)",[s.campaignId,key,id]);
  }
  transport.recall.mockClear();const proposal=await propose(s);expect(proposal.memoryIds).toEqual([saved.memoryId]);
  expect(transport.recall).toHaveBeenCalledOnce();expect(transport.recall.mock.calls[0]![0].namespace).toBe(active.row.namespace);
 });
 it('an old proposal UUID cannot be rebound to a corrected plan at the same game version',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);const old=await propose(s);
  const corrected=await confirm(s,{...plan,priority:'signal',reason:'Warn the boats first instead.'});await activate(s,corrected.memoryId);
  const rebound=await post('/api/cooperation/propose',s.cookie,{expectedVersion:12,clientTurnId:old.proposalId});expect(rebound.status).toBe(409);
  expect((await post('/api/cooperation/action',s.cookie,{proposalId:old.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()})).status).toBe(409);
 });
 it('concurrent identical commits return one stored event, with identical results',async()=>{
  const s=await session();const saved=await confirm(s);await activate(s,saved.memoryId);const proposal=await propose(s);
  const body={proposalId:proposal.proposalId,expectedVersion:12,clientActionId:crypto.randomUUID()};
  const responses=await Promise.all([post('/api/cooperation/action',s.cookie,body),post('/api/cooperation/action',s.cookie,body)]);
  expect(responses.map(r=>r.status)).toEqual([200,200]);expect(await responses[0].json()).toEqual(await responses[1].json());
  expect((await pool!.query('SELECT id FROM game_events WHERE campaign_id=$1 AND id=$2',[s.campaignId,body.clientActionId])).rowCount).toBe(1);
 });
});
