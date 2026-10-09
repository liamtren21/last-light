import type {Hono,Context} from 'hono';
import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {cooperationPlanSchema,cooperationOptions,commitCooperation,commitPresentAgreement,personalClosing,needsCooperation,cooperationComplete} from '../../src/game/cooperation';
import type {GameState} from '../../src/game/schema';
import {restoreGameState} from '../../src/game/save';
import {envelopeSchema,type MemoryEnvelope,isUnsafeMemoryContent} from '../memory/extract';
import {encryptPayload,decryptPayload} from '../memory/crypto';
import {factHash} from '../memory/scope';
import {checksum,createMemWal} from '../memory/adapter';
import {generateMiraReply} from '../llm/gemini';
import {config} from '../config';
import {story} from '../../src/game/story';
import {relationshipConsequences} from '../../src/game/relationship';
import {recallEngineEpisodes,episodesStillActive} from '../memory/episode-recall';
import {retryTransientRead} from '../memory/read-retry';
type Session={userId:string;campaignId:string;state:GameState};
export const PLAN_KEY='cooperation.plan';
const headSql=`SELECT h.active_revision,h.pending_revision,o.memory_id,o.namespace,r.blob_id,r.checksum FROM fact_heads h JOIN memory_outbox o ON o.memory_id=h.active_memory_id AND o.status='confirmed' AND o.user_id=$2 JOIN memory_receipts r ON r.memory_id=o.memory_id AND r.recall_verified_at IS NOT NULL WHERE h.campaign_id=$1 AND h.character_id='mira' AND h.fact_key_hash=$3 AND h.pending_revision IS NULL AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=h.campaign_id AND t.character_id=h.character_id AND t.fact_key_hash=h.fact_key_hash)`;
export async function exactPlanHead(db:Pick<Pool,'query'>|PoolClient,session:Pick<Session,'userId'|'campaignId'>){return (await db.query(headSql,[session.campaignId,session.userId,factHash(PLAN_KEY)])).rows[0];}
export function validatePlanRecall(text:string,head:{memory_id:string;active_revision:number;checksum:string},campaignId:string){
 if(checksum(text)!==head.checksum)throw new Error('PLAN_UNAVAILABLE');
 const envelope=envelopeSchema.parse(JSON.parse(text));
 if(envelope.memoryId!==head.memory_id||envelope.campaignId!==campaignId||envelope.characterId!=='mira'||envelope.revision!==head.active_revision||envelope.factKey!==PLAN_KEY||envelope.kind!=='promise'||envelope.source.type!=='user'||!z.string().uuid().safeParse(envelope.source.id).success||!envelope.cooperation||envelope.expiresAt&&Date.parse(envelope.expiresAt)<=Date.now())throw new Error('PLAN_UNAVAILABLE');
 if(isUnsafeMemoryContent(envelope.cooperation.reason)||isUnsafeMemoryContent(envelope.cooperation.cue??''))throw new Error('PLAN_UNAVAILABLE');
 return envelope;
}
export async function recallPlan(db:Pool,session:Session){
 const head=await exactPlanHead(db,session);if(!head)throw new Error('PLAN_NOT_READY');
 const remote=createMemWal(head.namespace);let timer:ReturnType<typeof setTimeout>|undefined;let activeRead=true;
 try{
  const recalled=await Promise.race([retryTransientRead(()=>remote.recall({namespace:head.namespace,query:'The confirmed cooperation plan',limit:10}),()=>activeRead),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PLAN_UNAVAILABLE')),10000);})]);
  const item=recalled.results.find(item=>item.blob_id===head.blob_id);if(!item)throw new Error('PLAN_UNAVAILABLE');
  const envelope=validatePlanRecall(item.text,head,session.campaignId);
  const active=await exactPlanHead(db,session);if(!active||active.memory_id!==head.memory_id||active.active_revision!==head.active_revision||active.checksum!==head.checksum||active.blob_id!==head.blob_id)throw new Error('PLAN_CHANGED');
  return {head,envelope};
 }finally{activeRead=false;if(timer)clearTimeout(timer);remote.destroy();}
}
export function registerCooperation(app:Hono,deps:{db:Pool|null;session:(c:Context)=>Promise<Session|undefined>;queue:(client:PoolClient,current:Session,candidate:MemoryEnvelope)=>Promise<void>}){
 const {db}=deps;
 const jsonSchema=z.object({expectedVersion:z.number().int().nonnegative(),clientTurnId:z.string().uuid()});
 const guard=async(c:Context)=>{
  const session=await deps.session(c);if(!session)return {response:c.json({error:'SESSION_NOT_FOUND'},401)};
  if(session.state.gameplayVersion!==2)return {response:c.json({error:'LEGACY_CAMPAIGN'},409)};
  if(!db||!config.sessionSecret)return {response:c.json({error:'MEMORY_UNAVAILABLE'},503)};
  return {session};
 };
 app.get('/api/cooperation',async c=>{
  const checked=await guard(c);if(checked.response)return checked.response;const session=checked.session!;
  const status=await db!.query(`SELECT h.pending_revision,o.status,EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=h.campaign_id AND t.character_id=h.character_id AND t.fact_key_hash=h.fact_key_hash) AS forgotten FROM fact_heads h LEFT JOIN memory_outbox o ON o.campaign_id=h.campaign_id AND o.fact_key_hash=h.fact_key_hash AND o.revision=GREATEST(h.active_revision,COALESCE(h.pending_revision,0)) WHERE h.campaign_id=$1 AND h.character_id='mira' AND h.fact_key_hash=$2`,[session.campaignId,factHash(PLAN_KEY)]);
  const row=status.rows[0];return c.json({status:row?.forgotten?'forgotten':row?.status==='failed'?'failed':row?.pending_revision?'pending':row?.status??'empty',required:needsCooperation(session.state),complete:cooperationComplete(session.state)});
 });
 app.post('/api/cooperation/draft',async c=>{
  const checked=await guard(c);if(checked.response)return checked.response;const session=checked.session!;
  const parsed=jsonSchema.extend({plan:cooperationPlanSchema}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'INVALID_PLAN'},400);
  if(isUnsafeMemoryContent(parsed.data.plan.reason)||isUnsafeMemoryContent(parsed.data.plan.cue??''))return c.json({error:'INVALID_PLAN'},400);
  if(parsed.data.expectedVersion!==session.state.version)return c.json({error:'VERSION_CONFLICT'},409);
  if(!needsCooperation(session.state))return c.json({error:'PLAN_SCENE_REQUIRED'},422);
  const cipher=encryptPayload(JSON.stringify(parsed.data.plan));
  await db!.query(`INSERT INTO cooperation_drafts(id,campaign_id,expected_version,payload_ciphertext) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[parsed.data.clientTurnId,session.campaignId,session.state.version,cipher]);
  const stored=(await db!.query('SELECT payload_ciphertext,expected_version,confirmed_memory_id,expires_at FROM cooperation_drafts WHERE campaign_id=$1 AND id=$2',[session.campaignId,parsed.data.clientTurnId])).rows[0];
  if(!stored||stored.confirmed_memory_id||!stored.payload_ciphertext||Date.parse(stored.expires_at)<=Date.now())return c.json({error:'TURN_ID_REUSED'},409);
  if(stored.expected_version!==session.state.version||decryptPayload(stored.payload_ciphertext)!==JSON.stringify(parsed.data.plan))return c.json({error:'TURN_ID_REUSED'},409);
  return c.json({draftId:parsed.data.clientTurnId,plan:parsed.data.plan});
 });
 app.post('/api/cooperation/confirm',async c=>{
  const checked=await guard(c);if(checked.response)return checked.response;const session=checked.session!;
  const parsed=z.object({draftId:z.string().uuid(),expectedVersion:z.number().int()}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'INVALID_PLAN'},400);
  const client=await db!.connect();try{
   await client.query('BEGIN');const locked=(await client.query('SELECT game_state,active_chat_until FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE',[session.campaignId,session.userId])).rows[0];
   const draft=(await client.query('SELECT * FROM cooperation_drafts WHERE campaign_id=$1 AND id=$2 FOR UPDATE',[session.campaignId,parsed.data.draftId])).rows[0];
   if(draft?.confirmed_memory_id){await client.query('COMMIT');return c.json({memoryId:draft.confirmed_memory_id,status:'pending'});}
   if(!locked||!draft||!draft.payload_ciphertext||Date.parse(draft.expires_at)<=Date.now()){await client.query('ROLLBACK');return c.json({error:'PLAN_DRAFT_EXPIRED'},409);}
   if(locked.active_chat_until&&Date.parse(locked.active_chat_until)>Date.now()){await client.query('ROLLBACK');return c.json({error:'TURN_IN_PROGRESS'},409);}
   const state=restoreGameState(locked.game_state);if(state.version!==parsed.data.expectedVersion||draft.expected_version!==state.version||!needsCooperation(state)){await client.query('ROLLBACK');return c.json({error:'VERSION_CONFLICT'},409);}
   const plan=cooperationPlanSchema.parse(JSON.parse(decryptPayload(draft.payload_ciphertext)));
   const memoryId=randomUUID();
   // Clear a tombstone only together with a new pending head: old workers can
   // never make the forgotten revision actionable during a rebuild.
   await client.query("DELETE FROM memory_tombstones WHERE campaign_id=$1 AND character_id='mira' AND fact_key_hash=$2",[session.campaignId,factHash(PLAN_KEY)]);
   const candidate=envelopeSchema.parse({schemaVersion:1,memoryId,campaignId:session.campaignId,characterId:'mira',kind:'promise',factKey:PLAN_KEY,revision:1,text:`Confirmed plan: meet at ${plan.meeting}; prioritize ${plan.priority}. Player's reason: ${plan.reason}${plan.technique&&plan.cue?` Player taught ${plan.technique} using the cue ${JSON.stringify(plan.cue)}.`:''}`,cooperation:plan,source:{type:'user',id:draft.id},occurredAt:new Date().toISOString()});
   await deps.queue(client,session,candidate);
   await client.query('UPDATE cooperation_drafts SET confirmed_memory_id=$3,payload_ciphertext=\'\' WHERE campaign_id=$1 AND id=$2',[session.campaignId,draft.id,memoryId]);
   // Correcting a plan removes prior scene authorization as well as proposals.
   await client.query('UPDATE campaigns SET game_state=$2 WHERE id=$1',[session.campaignId,{...state,cooperation:(state.cooperation??[]).map(event=>event.sceneId===state.sceneId?{...event,allowedChoices:[]}:event)}]);
   // Keep UUID bindings immutable: deleting them would let an old browser's
   // proof ID be rebound to a different plan at the same game version.
   await client.query('UPDATE cooperation_proposals SET expires_at=now() WHERE campaign_id=$1',[session.campaignId]);
   await client.query('COMMIT');return c.json({memoryId,status:'pending'});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
 app.post('/api/cooperation/rebuild',async c=>{
  const checked=await guard(c);if(checked.response)return checked.response;const session=checked.session!;
  const parsed=z.object({draftId:z.string().uuid(),expectedVersion:z.number().int().nonnegative()}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'INVALID_PLAN'},400);
  const client=await db!.connect();try{
   await client.query('BEGIN');
   const locked=(await client.query('SELECT game_state,active_chat_until FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE',[session.campaignId,session.userId])).rows[0];
   const replay=(await client.query("SELECT payload FROM game_events WHERE campaign_id=$1 AND id=$2 AND event_type='present-agreement'",[session.campaignId,parsed.data.draftId])).rows[0];
   if(replay){await client.query('COMMIT');return c.json(replay.payload);}
   const draft=(await client.query('SELECT * FROM cooperation_drafts WHERE campaign_id=$1 AND id=$2 FOR UPDATE',[session.campaignId,parsed.data.draftId])).rows[0];
   if(!locked||!draft||draft.confirmed_memory_id||!draft.payload_ciphertext||Date.parse(draft.expires_at)<=Date.now()){await client.query('ROLLBACK');return c.json({error:'PLAN_DRAFT_EXPIRED'},409);}
   if(locked.active_chat_until&&Date.parse(locked.active_chat_until)>Date.now()){await client.query('ROLLBACK');return c.json({error:'TURN_IN_PROGRESS'},409);}
   const state=restoreGameState(locked.game_state);
   if(state.version!==parsed.data.expectedVersion||draft.expected_version!==state.version||!needsCooperation(state)){await client.query('ROLLBACK');return c.json({error:'VERSION_CONFLICT'},409);}
   const plan=cooperationPlanSchema.parse(JSON.parse(decryptPayload(draft.payload_ciphertext)));
   const option=cooperationOptions(state,plan)[0];if(!option){await client.query('ROLLBACK');return c.json({error:'ACTION_NOT_ALLOWED'},422);}
   const next=commitPresentAgreement(state,option);
   // Personal words stay out of durable game event payloads; this is present
   // consent, not recalled memory or a storage receipt.
   const stored={state:next,consequence:'Mira prepares the step you agreed on here. This agreement has not been saved for another visit.',gesture:option.gesture,source:'present-agreement',memoryIds:[]};
   await client.query('UPDATE campaigns SET game_state=$2,version=$3,updated_at=now() WHERE id=$1',[session.campaignId,next,next.version]);
   await client.query("INSERT INTO game_events(id,campaign_id,event_type,payload) VALUES($1,$2,'present-agreement',$3)",[parsed.data.draftId,session.campaignId,stored]);
   await client.query("UPDATE cooperation_drafts SET payload_ciphertext='' WHERE campaign_id=$1 AND id=$2",[session.campaignId,parsed.data.draftId]);
   await client.query('UPDATE cooperation_proposals SET expires_at=now() WHERE campaign_id=$1',[session.campaignId]);
   await client.query('COMMIT');return c.json({...stored,consequence:option.consequence+' This is the plan we just rebuilt, not a recalled agreement.'});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
 app.post('/api/cooperation/propose',async c=>{
  const checked=await guard(c);if(checked.response)return checked.response;const session=checked.session!;
  const parsed=jsonSchema.extend({preferredAction:z.string().max(200).optional()}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'INVALID_PLAN'},400);
  if(parsed.data.expectedVersion!==session.state.version)return c.json({error:'VERSION_CONFLICT'},409);
  const existing=(await db!.query('SELECT scene_id,expected_version,expires_at,action_id,memory_id,revision FROM cooperation_proposals WHERE campaign_id=$1 AND id=$2',[session.campaignId,parsed.data.clientTurnId])).rows[0];
  if(existing&&(existing.scene_id!==session.state.sceneId||existing.expected_version!==session.state.version||Date.parse(existing.expires_at)<=Date.now()))return c.json({error:'TURN_ID_REUSED'},409);
  if(!needsCooperation(session.state)&&!session.state.sceneId.startsWith('ending-'))return c.json({error:'PLAN_SCENE_REQUIRED'},422);
  try{
   const [{head,envelope},episodes]=await Promise.all([recallPlan(db!,session),recallEngineEpisodes({db:db!,session,query:story[session.state.sceneId]!.place+' '+story[session.state.sceneId]!.mira})]);const plan=envelope.cooperation!;
   if(existing&&(existing.memory_id!==head.memory_id||existing.revision!==head.active_revision))return c.json({error:'TURN_ID_REUSED'},409);
   const alternatives=cooperationOptions(session.state,plan,episodes.facts);
   const requested=existing?.action_id??parsed.data.preferredAction;
   if(existing&&parsed.data.preferredAction&&existing.action_id!==parsed.data.preferredAction)return c.json({error:'TURN_ID_REUSED'},409);
   const options=requested?alternatives.filter(option=>option.id===requested):alternatives;
   if(requested&&!options.length)return c.json({error:'ACTION_NOT_ALLOWED'},422);
   const ending=session.state.sceneId.startsWith('ending-');
   if(ending){const executed=session.state.cooperation?.at(-1);if(!executed||!['signal-room','return-plan'].includes(executed.sceneId)||!executed.memoryIds.includes(head.memory_id))throw new Error('PLAN_CHANGED');}
   if(!options.length&&!ending)return c.json({status:'revise',plan,reason:'The flooded landing now requires gathering under the shelter roof. Revise the meeting place together.'});
   const witnessed=relationshipConsequences(session.state);
   const methodWasUsed=session.state.cooperation?.some(event=>event.sceneId===(session.state.sceneId==='ending-return'?'return-call':'signal-room')&&event.memoryIds.includes(head.memory_id))??false;
   const response=await generateMiraReply(session.state.sceneId,ending?'Give a personal closing sentence tied to the completed scene and the player reason. Do not invent feelings or achievements.':`Recall our confirmed plan and propose one of the allowed cooperation actions. Explain how the current observations fit our meeting place and priority. The player will confirm before we act. Set proposedAction to the allowed action ID.`,[`${envelope.text}`,...episodes.facts],{state:session.state,recentTurns:[],coordination:plan.technique&&plan.cue?{technique:plan.technique,cue:plan.cue}:undefined,cooperation:{allowedActions:options.map(option=>option.id),observations:[story[session.state.sceneId]!.place,story[session.state.sceneId]!.mira,...witnessed.observations],instruction:ending?'Personal coda from confirmed plan and completed scene only. '+(methodWasUsed?'The current plan was used for the rescue or signal handoff.':'The taught cue can be a personal reminder now. Do not claim this current method was used earlier; it may have been revised. Do not discuss missing evidence or records.'):'Choose one of these allowed proposals: '+options.map(option=>option.id+' = '+option.label+'. Planned physical coordination, not yet performed: '+option.consequence).join('; ')+'. Explain the remembered reason in the current location. The earlier rendezvous is a contingency, not an instruction to leave this scene. The proposal has not been carried out.'}});
   const active=await exactPlanHead(db!,session);const fresh=(await db!.query('SELECT version FROM campaigns WHERE id=$1 AND user_id=$2',[session.campaignId,session.userId])).rows[0];
   if(!await episodesStillActive(db!,session,episodes.selectedMemoryIds))throw new Error('PLAN_CHANGED');
   if(!active||active.memory_id!==head.memory_id||active.active_revision!==head.active_revision||fresh?.version!==session.state.version||envelope.expiresAt&&Date.parse(envelope.expiresAt)<=Date.now())throw new Error('PLAN_CHANGED');
   if(ending)return c.json({status:'coda',dialogue:response.dialogue,closingGesture:methodWasUsed?personalClosing(session.state,plan):'',plan,memoryIds:[head.memory_id],episodeEvidence:{status:episodes.status,memoryIds:episodes.selectedMemoryIds}});
   const option=options.find(option=>option.id===response.proposedAction);if(!option)throw new Error('PROPOSAL_NOT_GROUNDED');
   const evidenceIds=option.id.endsWith(':episode-review')?episodes.selectedMemoryIds:[];
   const inserted=await db!.query(`INSERT INTO cooperation_proposals(id,campaign_id,scene_id,expected_version,action_id,memory_id,revision,blob_id,checksum,episode_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[parsed.data.clientTurnId,session.campaignId,session.state.sceneId,session.state.version,option.id,head.memory_id,head.active_revision,head.blob_id,head.checksum,evidenceIds]);
   if(!inserted.rowCount){const prior=(await db!.query('SELECT * FROM cooperation_proposals WHERE campaign_id=$1 AND id=$2',[session.campaignId,parsed.data.clientTurnId])).rows[0];if(!prior||prior.scene_id!==session.state.sceneId||prior.expected_version!==session.state.version||prior.action_id!==option.id||prior.memory_id!==head.memory_id||prior.revision!==head.active_revision||Date.parse(prior.expires_at)<=Date.now())return c.json({error:'TURN_ID_REUSED'},409);}
   return c.json({status:'proposed',proposalId:parsed.data.clientTurnId,dialogue:response.dialogue,plan,option,alternatives,memoryIds:[head.memory_id],episodeEvidence:{status:episodes.status,memoryIds:episodes.selectedMemoryIds}});
  }catch(error){const message=error instanceof Error?error.message:'';console.warn('Cooperation request failed',{type:error instanceof Error?error.name:'unknown',status:(error as {status?:number}).status,code:/^(?:GROUNDING_[A-Za-z_]+|REQUESTY_HTTP_[0-9]+|PLAN_[A-Z_]+|PROPOSAL_NOT_GROUNDED)$/.test(message)?message:'UPSTREAM_OR_VALIDATION_FAILED'});const code=error instanceof Error&&['PLAN_NOT_READY','PLAN_CHANGED','PLAN_UNAVAILABLE','PROPOSAL_NOT_GROUNDED'].includes(error.message)?error.message:'COOPERATION_UNAVAILABLE';return c.json({error:code},503);}
 });
 app.post('/api/cooperation/action',async c=>{
  const checked=await guard(c);if(checked.response)return checked.response;const session=checked.session!;
  const parsed=z.object({proposalId:z.string().uuid(),expectedVersion:z.number().int(),clientActionId:z.string().uuid()}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'INVALID_ACTION'},400);
  const replay=(await db!.query('SELECT payload,event_type FROM game_events WHERE campaign_id=$1 AND id=$2',[session.campaignId,parsed.data.clientActionId])).rows[0];
  if(replay){if(replay.event_type!=='cooperation'||replay.payload.proposalId!==parsed.data.proposalId)return c.json({error:'ACTION_ID_REUSED'},409);return c.json(replay.payload);}
  // Fetch content afresh; metadata alone never recreates the plan on commit.
  let recalled:Awaited<ReturnType<typeof recallPlan>>;let episodes:Awaited<ReturnType<typeof recallEngineEpisodes>>;
  try{[recalled,episodes]=await Promise.all([recallPlan(db!,session),recallEngineEpisodes({db:db!,session,query:story[session.state.sceneId]!.place+' reunion'})]);}catch{return c.json({error:'PLAN_NOT_READY'},409);}
  const client=await db!.connect();try{
   await client.query('BEGIN');const locked=(await client.query('SELECT game_state,active_chat_until FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE',[session.campaignId,session.userId])).rows[0];
   const previous=(await client.query('SELECT payload,event_type FROM game_events WHERE campaign_id=$1 AND id=$2',[session.campaignId,parsed.data.clientActionId])).rows[0];if(previous){
    if(previous.event_type!=='cooperation'||previous.payload.proposalId!==parsed.data.proposalId){await client.query('ROLLBACK');return c.json({error:'ACTION_ID_REUSED'},409);}
    await client.query('COMMIT');return c.json(previous.payload);
   }
   if(!locked){await client.query('ROLLBACK');return c.json({error:'CAMPAIGN_NOT_FOUND'},404);}
   if(locked.active_chat_until&&Date.parse(locked.active_chat_until)>Date.now()){await client.query('ROLLBACK');return c.json({error:'TURN_IN_PROGRESS'},409);}
   const state=restoreGameState(locked.game_state);
   const proposal=(await client.query('SELECT * FROM cooperation_proposals WHERE campaign_id=$1 AND id=$2',[session.campaignId,parsed.data.proposalId])).rows[0];const head=await exactPlanHead(client,session);
   if(!proposal||!head||proposal.expected_version!==state.version||parsed.data.expectedVersion!==state.version||proposal.scene_id!==state.sceneId||Date.parse(proposal.expires_at)<=Date.now()||proposal.memory_id!==head.memory_id||proposal.revision!==head.active_revision||proposal.blob_id!==head.blob_id||proposal.checksum!==head.checksum||recalled.head.memory_id!==head.memory_id||recalled.head.active_revision!==head.active_revision||recalled.head.checksum!==head.checksum){await client.query('ROLLBACK');return c.json({error:'PROPOSAL_STALE'},409);}
   const evidenceIds:string[]=proposal.episode_ids??[];
   if(proposal.action_id.endsWith(':episode-review')&&(!evidenceIds.length||!evidenceIds.every(id=>episodes.selectedMemoryIds.includes(id))||!await episodesStillActive(client,session,evidenceIds))){await client.query('ROLLBACK');return c.json({error:'PROPOSAL_STALE'},409);}
   const option=cooperationOptions(state,recalled.envelope.cooperation!,evidenceIds.length?episodes.facts:[]).find(option=>option.id===proposal.action_id);if(!option||cooperationComplete(state)){await client.query('ROLLBACK');return c.json({error:'ACTION_NOT_ALLOWED'},422);}
   if(recalled.envelope.expiresAt&&Date.parse(recalled.envelope.expiresAt)<=Date.now()){await client.query('ROLLBACK');return c.json({error:'PROPOSAL_STALE'},409);}
   const next=commitCooperation(state,option,[head.memory_id,...evidenceIds]);
   const episodeBlobIds=evidenceIds.map(id=>episodes.selectedBlobIds?.[episodes.selectedMemoryIds.indexOf(id)]).filter((id):id is string=>!!id);
   const result={state:next,consequence:option.consequence,gesture:option.gesture,proposalId:proposal.id,memoryIds:[head.memory_id,...evidenceIds],blobIds:[head.blob_id,...episodeBlobIds]};
   await client.query('UPDATE campaigns SET game_state=$2,version=$3,updated_at=now() WHERE id=$1',[session.campaignId,next,next.version]);
   await client.query("INSERT INTO game_events(id,campaign_id,event_type,payload) VALUES($1,$2,'cooperation',$3)",[parsed.data.clientActionId,session.campaignId,result]);
   await client.query('COMMIT');return c.json(result);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
}
