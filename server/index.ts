import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { initialState, story } from '../src/game/story';
import { transition } from '../src/game/reducer';
import { config } from './config';
import { inferChatTurn,type PendingCorrection } from './chat/inference';
import { pool, migrate } from './db';
import { extractCandidate, validateCandidateProposal } from './memory/extract';
import {buildActionEpisode} from './memory/episodes';
import { opaqueNamespace, factHash } from './memory/scope';
import { encryptPayload } from './memory/crypto';
import { createMemWal } from './memory/adapter';
import { canRetryMemory } from './memory/resolve';
import { retrieveVerifiedMemories, type RecallHead } from './memory/retrieval';
import type { GameState } from '../src/game/schema';
import { restoreGameState } from '../src/game/save';
import { LocalGameStore } from './game/local-store';
import type { RecentTurn } from './chat/context';
import { resolve } from 'node:path';
import {registerCooperation,exactPlanHead,recallPlan} from './game/cooperation';
import {needsCooperation} from '../src/game/cooperation';
import {retryTransientRead} from './memory/read-retry';

const sessions = new Map<string, { userId: string; campaignId: string; state: GameState }>();
const localActionResults = new Map<string, GameState>();
const turnCache = new Map<string, unknown>();
const turnFingerprints=new Map<string,string>();
const localTurnInFlight = new Set<string>();
const localCampaignInFlight = new Set<string>();
const recoveryFailures = new Map<string, { count: number; until: number }>();
const chatRates = new Map<string, { start: number; count: number }>();
const visits = new Map<string,{turns:RecentTurn[];expires:number;pendingCorrection?:PendingCorrection}>();
const localStore = !pool && process.env.NODE_ENV !== 'test' ? new LocalGameStore(resolve('data/game-save.json')) : null;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieToken = (c: Context) => getCookie(c, 'last_light_session');

async function queueMemory(client: import('pg').PoolClient, current: { userId: string; campaignId: string }, candidate: NonNullable<ReturnType<typeof extractCandidate>>) {
  if (!config.sessionSecret) return;
  await client.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE', [current.campaignId]);
  const duplicate = await client.query('SELECT memory_id FROM memory_outbox WHERE memory_id=$1', [candidate.memoryId]);
  if (duplicate.rowCount) return;
  const logicalKey = factHash(candidate.factKey!);
  const head = await client.query('SELECT active_revision,pending_revision,active_memory_id FROM fact_heads WHERE campaign_id=$1 AND character_id=\'mira\' AND fact_key_hash=$2 FOR UPDATE', [current.campaignId, logicalKey]);
  const revision = Math.max(head.rows[0]?.active_revision ?? 0, head.rows[0]?.pending_revision ?? 0) + 1;
  const envelope = { ...candidate, revision, supersedes: head.rows[0]?.active_memory_id ?? undefined };
  const namespace = ['episode','summary'].includes(envelope.kind)?opaqueNamespace(current.userId,current.campaignId):opaqueNamespace(current.userId, current.campaignId, 'mira', candidate.factKey, revision);
  await client.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,fact_key_hash,revision,namespace,payload_ciphertext,status,memory_kind) VALUES($1,$2,$3,'mira',$4,$5,$6,$7,'queued',$8) ON CONFLICT DO NOTHING", [candidate.memoryId, current.userId, current.campaignId, logicalKey, revision, namespace, encryptPayload(JSON.stringify(envelope)),envelope.kind]);
  await client.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,pending_revision) VALUES($1,'mira',$2,0,$3) ON CONFLICT(campaign_id,character_id,fact_key_hash) DO UPDATE SET pending_revision=excluded.pending_revision,updated_at=now()", [current.campaignId, logicalKey, revision]);
}

async function loadSession(token: string | undefined) {
  if (!token) return undefined;
  if (pool) {
    const result = await pool.query(`SELECT s.user_id,s.campaign_id,c.game_state FROM sessions s JOIN campaigns c ON c.id=s.campaign_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(token)]);
    const row = result.rows[0];
    return row ? { userId: row.user_id as string, campaignId: row.campaign_id as string, state: restoreGameState(row.game_state) } : undefined;
  }
  return sessions.get(token) ?? localStore?.get(hash(token));
}

export async function recallVerifiedFacts(session: { userId: string; campaignId: string }, query: string) {
  const recallStarted=Date.now();
  if (!pool || !config.memwalAccountId || !config.memwalDelegateKey || !config.memwalRelayerUrl || !config.sessionSecret) return { facts: [] as string[], status: 'not_configured' as const };
  // PostgreSQL supplies receipt/head metadata only. Text must come from Walrus recall.
  const durableKeys = ['identity.name','promise.meeting','route.reason'].map(factHash);
  const eligible = `FROM fact_heads h JOIN memory_outbox o ON o.memory_id=h.active_memory_id AND o.status='confirmed' JOIN memory_receipts r ON r.memory_id=o.memory_id AND r.recall_verified_at IS NOT NULL WHERE h.campaign_id=$1 AND h.character_id='mira' AND h.pending_revision IS NULL AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=h.campaign_id AND t.character_id=h.character_id AND t.fact_key_hash=h.fact_key_hash)`;
  const episodicNamespace=opaqueNamespace(session.userId,session.campaignId);
  const indexed=await pool.query(`SELECT 1 ${eligible} AND o.namespace=$2 LIMIT 1`,[session.campaignId,episodicNamespace]);
  let semantic:Awaited<ReturnType<ReturnType<typeof createMemWal>['recall']>>|undefined;
  const remote=createMemWal(episodicNamespace);
  try {
  if(indexed.rowCount){
    let timer:ReturnType<typeof setTimeout>|undefined;let activeRead=true;
    try{semantic=await Promise.race([retryTransientRead(()=>remote.recall({namespace:episodicNamespace,query:query.slice(0,2000),limit:50}),()=>activeRead),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEMORY_RECALL_TIMEOUT')),10_000);})]);}
    catch{return {facts:[] as string[],status:'unavailable' as const};}
    finally{activeRead=false;if(timer)clearTimeout(timer);}
    if(semantic.dropped_count)return {facts:[] as string[],status:'unavailable' as const};
  }
  const matched=semantic?.results.map(item=>item.blob_id)??[];
  const heads = await pool.query(`SELECT h.fact_key_hash,h.active_revision,h.campaign_id,h.character_id,o.memory_id,o.namespace,o.created_at,o.memory_kind,r.blob_id,r.checksum,COUNT(*) OVER() AS total_candidates ${eligible} AND (o.namespace<>$4 OR r.blob_id=ANY($3::text[])) ORDER BY CASE WHEN o.memory_kind IN ('preference','promise','reason') OR h.fact_key_hash=ANY($2::text[]) THEN 0 WHEN r.blob_id=ANY($3::text[]) THEN 1 ELSE 2 END,array_position($3::text[],r.blob_id),o.created_at DESC LIMIT 16`, [session.campaignId,durableKeys,matched,episodicNamespace]);
  const metadata: RecallHead[] = heads.rows.map(row=>({factKeyHash:row.fact_key_hash,activeRevision:row.active_revision,memoryId:row.memory_id,namespace:row.namespace,blobId:row.blob_id,checksum:row.checksum,campaignId:row.campaign_id,characterId:row.character_id,createdAt:new Date(row.created_at).getTime(),kind:row.memory_kind??undefined,mutable:durableKeys.includes(row.fact_key_hash)}));
  const result = await retrieveVerifiedMemories({heads:metadata,scope:{campaignId:session.campaignId,characterId:'mira'},query,
    budget:{totalMs:Math.max(1,12_000-(Date.now()-recallStarted))},
    recall:async(namespace,search,limit)=>{if(namespace===episodicNamespace&&semantic)return semantic;return remote.recall({namespace,query:search,limit});},
    destroy:()=>{}, // Shared client lives until the entire verified read finishes.
  });
  result.durationMs=Date.now()-recallStarted;
  if(semantic)result.calls=1+metadata.filter(head=>head.namespace!==episodicNamespace).length;
  result.omittedCandidateCount = Math.max(0,Number(heads.rows[0]?.total_candidates??0)-result.candidateCount);
  // A forget/correction may have occurred while waiting for remote recall.
  if(result.selectedMemoryIds.length){
    const stillActive=await pool.query(`SELECT o.memory_id,h.active_revision,r.checksum,r.blob_id ${eligible} AND o.memory_id=ANY($2::uuid[])`,[session.campaignId,result.selectedMemoryIds]);
    if(stillActive.rowCount!==result.selectedMemoryIds.length || stillActive.rows.some(row=>!metadata.some(head=>head.memoryId===row.memory_id&&head.activeRevision===row.active_revision&&head.checksum===row.checksum&&head.blobId===row.blob_id)))return {...result,facts:[],status:'unavailable' as const,selectedMemoryIds:[],selectedBlobIds:[]};
  }
  return result;
  } finally { remote.destroy(); }
}

function createApp() {
  const app = new Hono();
  app.use('/api/*', cors({ origin: config.publicOrigin, credentials: true }));
  app.use('/api/*', async(c,next)=>{
    const origin=c.req.header('origin');
    if(c.req.method!=='GET' && origin && origin!==config.publicOrigin)return c.json({error:'ORIGIN_NOT_ALLOWED'},403);
    if(c.req.method!=='GET' && c.req.header('sec-fetch-site')==='cross-site')return c.json({error:'ORIGIN_NOT_ALLOWED'},403);
    await next();
  });
  app.onError((error, c) => {
    console.error('LAST LIGHT API error:', error.name);
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });
  app.get('/api/health', (c) => c.json({ status: 'ok', availability: config.availability }));
  registerCooperation(app,{db:pool,session:c=>loadSession(cookieToken(c)),queue:queueMemory});
  async function nameStatus(campaignId:string,client?:import('pg').PoolClient){
    if(!pool)return {named:false,status:'unavailable',verified:false};
    const result=await (client??pool).query(`SELECT o.memory_id,o.status,(r.recall_verified_at IS NOT NULL) AS verified FROM fact_heads h JOIN memory_outbox o ON o.campaign_id=h.campaign_id AND o.character_id=h.character_id AND o.fact_key_hash=h.fact_key_hash AND o.revision=GREATEST(h.active_revision,COALESCE(h.pending_revision,0)) LEFT JOIN memory_receipts r ON r.memory_id=o.memory_id WHERE h.campaign_id=$1 AND h.character_id='mira' AND h.fact_key_hash=$2 AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=h.campaign_id AND t.character_id=h.character_id AND t.fact_key_hash=h.fact_key_hash)`,[campaignId,factHash('identity.name')]);
    const row=result.rows[0];return row?{named:true,status:row.status,verified:row.verified,memoryId:row.memory_id}:{named:false,status:'empty',verified:false};
  }
  app.get('/api/onboarding',async c=>{
    const current=await loadSession(cookieToken(c));if(!current)return c.json({error:'SESSION_NOT_FOUND'},401);
    return c.json(await nameStatus(current.campaignId));
  });
  app.post('/api/onboarding/name',async c=>{
    const current=await loadSession(cookieToken(c));if(!current)return c.json({error:'SESSION_NOT_FOUND'},401);
    const parsed=z.object({name:z.string().trim().min(1).max(60).regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} '’_-]*$/u),clientTurnId:z.string().uuid()}).safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:'INVALID_PLAYER_NAME'},400);
    if(!pool||!config.availability.memory)return c.json({error:'MEMORY_UNAVAILABLE'},503);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const locked=await client.query('SELECT active_chat_until FROM campaigns WHERE id=$1 FOR UPDATE',[current.campaignId]);
      if(locked.rows[0]?.active_chat_until&&new Date(locked.rows[0].active_chat_until).getTime()>Date.now()){await client.query('ROLLBACK');return c.json({error:'TURN_IN_PROGRESS'},409);}
      const existing=await nameStatus(current.campaignId,client);
      if(existing.named){await client.query('COMMIT');return c.json(existing);}
      // Structured, explicit user input requires no LLM interpretation. Never
      // derive the name from Mira or a client-supplied namespace/identity.
      const candidate=extractCandidate({campaignId:current.campaignId,eventId:parsed.data.clientTurnId,message:`Call me ${parsed.data.name}.`});
      if(!candidate||candidate.factKey!=='identity.name'){await client.query('ROLLBACK');return c.json({error:'INVALID_PLAYER_NAME'},400);}
      await queueMemory(client,current,candidate);await client.query('COMMIT');
      return c.json(await nameStatus(current.campaignId));
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.post('/api/session', async (c) => {
    const token = randomUUID(); const userId = randomUUID(); const campaignId = randomUUID(); const state = initialState({gameplayVersion:2});
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO users(id) VALUES($1)', [userId]);
        await client.query('INSERT INTO campaigns(id,user_id,game_state) VALUES($1,$2,$3)', [campaignId, userId, state]);
        await client.query('INSERT INTO sessions(token_hash,user_id,campaign_id,expires_at) VALUES($1,$2,$3,now()+interval \'30 days\')', [hash(token), userId, campaignId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } else { localStore?.save(hash(token),{userId,campaignId,state}); sessions.set(token, { userId, campaignId, state }); }
    setCookie(c, 'last_light_session', token, { httpOnly: true, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 });
    return c.json({ state, availability: config.availability });
  });
  app.post('/api/recovery/create', async (c) => {
    const current = await loadSession(cookieToken(c));
    if (!current || !pool) return c.json({ error: pool ? 'SESSION_NOT_FOUND' : 'DATABASE_REQUIRED' }, pool ? 401 : 503);
    const code = randomBytes(24).toString('base64url');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE recovery_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [current.userId]);
      await client.query('INSERT INTO recovery_tokens(token_hash,user_id) VALUES($1,$2)', [hash(code), current.userId]);
      await client.query('COMMIT');
      return c.json({ code });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  app.post('/api/recovery/restore', async (c) => {
    if (!pool) return c.json({ error: 'DATABASE_REQUIRED' }, 503);
    let body: unknown; try { body = await c.req.json(); } catch { return c.json({ error: 'INVALID_JSON' }, 400); }
    const parsed = z.object({ code: z.string().min(24).max(64) }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'INVALID_RECOVERY_CODE' }, 400);
    const digest = hash(parsed.data.code.trim()); const prior = recoveryFailures.get(digest);
    if (prior && prior.until > Date.now() && prior.count >= 5) return c.json({ error: 'RECOVERY_RATE_LIMITED' }, 429);
    const client = await pool.connect();
    let row: { user_id:string; campaign_id:string; game_state:GameState } | undefined;
    try {
      await client.query('BEGIN');
      const tokenRow = await client.query('UPDATE recovery_tokens SET used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND used_at IS NULL RETURNING user_id',[digest]);
      if (!tokenRow.rowCount) { await client.query('ROLLBACK'); recoveryFailures.set(digest,{count:(prior?.count??0)+1,until:Date.now()+60*60*1000}); return c.json({error:'INVALID_RECOVERY_CODE'},401); }
      const campaign = await client.query('SELECT id AS campaign_id,game_state FROM campaigns WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1',[tokenRow.rows[0].user_id]);
      if (!campaign.rowCount) { await client.query('ROLLBACK'); return c.json({error:'CAMPAIGN_NOT_FOUND'},404); }
      row={user_id:tokenRow.rows[0].user_id,campaign_id:campaign.rows[0].campaign_id,game_state:campaign.rows[0].game_state};
      const token = randomUUID();
      await client.query('INSERT INTO sessions(token_hash,user_id,campaign_id,expires_at) VALUES($1,$2,$3,now()+interval \'30 days\')',[hash(token),row.user_id,row.campaign_id]);
      await client.query('COMMIT');
      setCookie(c, 'last_light_session', token, { httpOnly: true, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    if (!row) return c.json({error:'INVALID_RECOVERY_CODE'},401);
    recoveryFailures.delete(digest);
    return c.json({ state: row.game_state as GameState, availability: config.availability });
  });
  app.post('/api/recovery/revoke', async (c) => {
    const current = await loadSession(cookieToken(c));
    if (!current || !pool) return c.json({ error: pool ? 'SESSION_NOT_FOUND' : 'DATABASE_REQUIRED' }, pool ? 401 : 503);
    await pool.query('UPDATE recovery_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [current.userId]);
    return c.json({ revoked: true });
  });
  app.get('/api/game', async (c) => {
    const current = await loadSession(cookieToken(c));
    return current ? c.json({ state: current.state, availability: config.availability }) : c.json({ error: 'SESSION_NOT_FOUND' }, 401);
  });
  app.post('/api/campaigns/new', async (c) => {
    const token = cookieToken(c); const current = await loadSession(token);
    if (!current || !token) return c.json({ error: 'SESSION_NOT_FOUND' }, 401);
    const campaignId = randomUUID(); const state = initialState({gameplayVersion:2});
    state.completedEndings=[...current.state.completedEndings];
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO campaigns(id,user_id,game_state) VALUES($1,$2,$3)', [campaignId,current.userId,state]);
        await client.query('UPDATE sessions SET campaign_id=$2 WHERE token_hash=$1', [hash(token),campaignId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } else { localStore?.save(hash(token),{userId:current.userId,campaignId,state}); sessions.set(token, { userId: current.userId, campaignId, state }); }
    return c.json({ state, availability: config.availability });
  });
  app.get('/api/memories', async (c) => {
    const current = await loadSession(cookieToken(c));
    if (!current) return c.json({ error: 'SESSION_NOT_FOUND' }, 401);
    if (!pool) return c.json({ jobs: [] });
    const result = await pool.query(`SELECT o.memory_id,o.status,o.error_code,o.created_at,o.job_id,(length(o.payload_ciphertext)>0) AS payload_present,(r.recall_verified_at IS NOT NULL) AS recall_verified,EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=o.campaign_id AND t.character_id=o.character_id AND t.fact_key_hash=o.fact_key_hash) AS tombstoned FROM memory_outbox o LEFT JOIN memory_receipts r ON r.memory_id=o.memory_id WHERE o.campaign_id=$1 ORDER BY o.created_at DESC LIMIT 30`, [current.campaignId]);
    return c.json({ jobs: result.rows.map(row=>({memory_id:row.memory_id,status:row.status,error_code:row.error_code,created_at:row.created_at,recall_verified:row.recall_verified,forgotten:row.tombstoned,retryable:canRetryMemory(row.status,row.job_id,row.error_code,row.payload_present,row.tombstoned)})) });
  });
  app.post('/api/memories/retry', async (c) => {
    const current = await loadSession(cookieToken(c));
    if (!current) return c.json({ error: 'SESSION_NOT_FOUND' }, 401);
    if (!pool) return c.json({ error: 'DATABASE_REQUIRED' }, 503);
    let body: unknown; try { body = await c.req.json(); } catch { return c.json({ error: 'INVALID_JSON' }, 400); }
    const parsed = z.object({ memoryId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'INVALID_MEMORY_ID' }, 400);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE',[current.campaignId]);
      const selected=await client.query(`SELECT o.* , EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=o.campaign_id AND t.character_id=o.character_id AND t.fact_key_hash=o.fact_key_hash) AS tombstoned FROM memory_outbox o WHERE o.memory_id=$1 AND o.campaign_id=$2 FOR UPDATE`,[parsed.data.memoryId,current.campaignId]);
      const row=selected.rows[0];
      if(!row||!canRetryMemory(row.status,row.job_id,row.error_code,Boolean(row.payload_ciphertext),row.tombstoned)){await client.query('ROLLBACK');return c.json({error:'MEMORY_NOT_RETRYABLE'},409);}
      await client.query("UPDATE memory_outbox SET status=$2,attempts=0,error_code=NULL,next_attempt_at=now(),lease_until=NULL,updated_at=now() WHERE memory_id=$1",[parsed.data.memoryId,row.job_id?'accepted':'queued']);
      await client.query('COMMIT');return c.json({retried:true});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.post('/api/memories/forget',async(c)=>{
    const current=await loadSession(cookieToken(c));
    if(!current)return c.json({error:'SESSION_NOT_FOUND'},401);
    if(!pool)return c.json({error:'DATABASE_REQUIRED'},503);
    const parsed=z.object({memoryId:z.string().uuid()}).safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:'INVALID_MEMORY_ID'},400);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const campaign=await client.query('SELECT active_chat_until FROM campaigns WHERE id=$1 FOR UPDATE',[current.campaignId]);
      if(campaign.rows[0]?.active_chat_until&&new Date(campaign.rows[0].active_chat_until)>new Date()){await client.query('ROLLBACK');return c.json({error:'TURN_IN_PROGRESS'},409);}
      const row=await client.query('SELECT fact_key_hash FROM memory_outbox WHERE memory_id=$1 AND campaign_id=$2',[parsed.data.memoryId,current.campaignId]);
      if(!row.rowCount){await client.query('ROLLBACK');return c.json({error:'MEMORY_NOT_FOUND'},404);}
      await client.query("INSERT INTO memory_tombstones(campaign_id,character_id,fact_key_hash,reason) VALUES($1,'mira',$2,'player-request') ON CONFLICT DO NOTHING",[current.campaignId,row.rows[0].fact_key_hash]);
      await client.query('COMMIT');
      for(const key of visits.keys())if(key.startsWith(`${current.campaignId}:`))visits.delete(key);
      for(const key of turnCache.keys())if(key.startsWith(`${current.campaignId}:`))turnCache.delete(key);
      await pool.query('UPDATE chat_turns SET response_json=NULL,user_message=\'\',expires_at=now() WHERE campaign_id=$1',[current.campaignId]);
      return c.json({forgotten:true,scope:'excluded-from-recall',onchainDeleted:false});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.post('/api/actions', async (c) => {
    const token = cookieToken(c); const current = await loadSession(token);
    if (!current || !token) return c.json({ error: 'SESSION_NOT_FOUND' }, 401);
    let body: unknown; try { body = await c.req.json(); } catch { return c.json({ error: 'INVALID_JSON' }, 400); }
    const parsed = z.object({ choiceId: z.string(), expectedVersion: z.number().int(), clientActionId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'INVALID_ACTION' }, 400);
    if (pool) {
      let cooperationEvidence:Awaited<ReturnType<typeof recallPlan>>|undefined;
      if(needsCooperation(current.state)){
        const previous=await pool.query('SELECT payload,event_type FROM game_events WHERE campaign_id=$1 AND id=$2',[current.campaignId,parsed.data.clientActionId]);
        if(previous.rowCount){
          if(previous.rows[0].event_type!=='choice'||previous.rows[0].payload.choiceId!==parsed.data.choiceId)return c.json({error:'ACTION_ID_REUSED'},409);
          return c.json({state:previous.rows[0].payload.state});
        }
        try{cooperationEvidence=await recallPlan(pool,current);}catch{return c.json({error:'COOPERATION_REQUIRED'},422);}
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT game_state,version,active_chat_until FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE', [current.campaignId, current.userId]);
        const previous = await client.query('SELECT payload FROM game_events WHERE campaign_id=$1 AND id=$2', [current.campaignId, parsed.data.clientActionId]);
        if (previous.rowCount) {
          if(previous.rows[0].payload.choiceId!==parsed.data.choiceId){await client.query('ROLLBACK');return c.json({error:'ACTION_ID_REUSED'},409);}
          await client.query('COMMIT'); return c.json({ state: (previous.rows[0].payload as { state: GameState }).state });
        }
        const state = locked.rows[0]?.game_state ? restoreGameState(locked.rows[0].game_state) : undefined;
        if (!state) { await client.query('ROLLBACK'); return c.json({ error: 'CAMPAIGN_NOT_FOUND' }, 404); }
        if (locked.rows[0].active_chat_until && new Date(locked.rows[0].active_chat_until).getTime() > Date.now()) { await client.query('ROLLBACK'); return c.json({ error: 'TURN_IN_PROGRESS' }, 409); }
        if(needsCooperation(state)){
          const head=await exactPlanHead(client,current);const event=[...(state.cooperation??[])].reverse().find(event=>event.sceneId===state.sceneId);
          if(!head||!event?.memoryIds.includes(head.memory_id)||!cooperationEvidence||cooperationEvidence.head.memory_id!==head.memory_id||cooperationEvidence.head.active_revision!==head.active_revision||cooperationEvidence.envelope.expiresAt&&Date.parse(cooperationEvidence.envelope.expiresAt)<=Date.now()){await client.query('ROLLBACK');return c.json({error:'COOPERATION_REQUIRED'},422);}
        }
        const result = transition(state, parsed.data);
        if (!result.ok) { await client.query('ROLLBACK'); return c.json({ error: result.error }, result.error === 'VERSION_CONFLICT' ? 409 : 422); }
        await client.query('UPDATE campaigns SET game_state=$2,version=$3,updated_at=now() WHERE id=$1', [current.campaignId, result.state, result.state.version]);
        await client.query('INSERT INTO game_events(id,campaign_id,event_type,payload) VALUES($1,$2,\'choice\',$3)', [parsed.data.clientActionId, current.campaignId, { choiceId: parsed.data.choiceId, state: result.state }]);
        const episode=buildActionEpisode(state,result.state,parsed.data.choiceId,current.campaignId,parsed.data.clientActionId);
        if(episode)await queueMemory(client,current,episode);
        if (state.gameplayVersion!==2 && parsed.data.choiceId === 'promise-meet') {
          const statement = story[state.sceneId]?.choices.find((item) => item.id === parsed.data.choiceId)?.text;
          const candidate = statement ? extractCandidate({ message: statement, campaignId: current.campaignId, eventId: parsed.data.clientActionId, sourceType: 'game' }) : null;
          if (candidate) await queueMemory(client, current, candidate);
        }
        await client.query('COMMIT');
        if(state.gameplayVersion===2&&['first-pause','second-pause'].includes(state.sceneId))for(const key of visits.keys())if(key.startsWith(`${current.campaignId}:`))visits.delete(key);
        return c.json({ state: result.state });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const actionKey = `${current.campaignId}:${parsed.data.clientActionId}`;
    const saved = localActionResults.get(actionKey) ?? localStore?.action(actionKey);
    if (saved) return c.json({ state: saved });
    if (localCampaignInFlight.has(current.campaignId)) return c.json({ error: 'TURN_IN_PROGRESS' }, 409);
    const result = transition(current.state, parsed.data);
    if (!result.ok) return c.json({ error: result.error }, result.error === 'VERSION_CONFLICT' ? 409 : 422);
    localStore?.save(hash(token),{...current,state:result.state},actionKey);
    sessions.set(token, { ...current, state: result.state });
    localActionResults.set(actionKey, result.state);
    return c.json({ state: result.state });
  });
  const chatHandler = async (c:Context,onStage?:((stage:string)=>Promise<void>),revisit=false) => {
    const token = cookieToken(c); const current = await loadSession(token);
    if (!current) return c.json({ error: 'SESSION_NOT_FOUND' }, 401);
    let body: unknown; try { body = await c.req.json(); } catch { return c.json({ error: 'INVALID_JSON' }, 400); }
    if(revisit){
      const request=z.object({clientTurnId:z.string().uuid(),expectedVersion:z.number().int()}).safeParse(body);
      if(!request.success)return c.json({error:'INVALID_MESSAGE'},400);
      body={...request.data,message:'The player has returned for a new visit. Greet them briefly using a relevant verified personal fact or promise. Ask whether their plan still holds. Never invent a previous request, a kept map, or a completed action.'};
    }
    const parsed = z.object({ message: z.string().trim().min(1).max(2000), clientTurnId: z.string().uuid(), expectedVersion: z.number().int() }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'INVALID_MESSAGE' }, 400);
    if (parsed.data.expectedVersion !== current.state.version) return c.json({ error: 'VERSION_CONFLICT' }, 409);
    const now=Date.now(); const rate=chatRates.get(current.campaignId);
    if (rate && now-rate.start<60_000 && rate.count>=8) return c.json({error:'RATE_LIMITED'},429);
    if (!rate || now-rate.start>=60_000) chatRates.set(current.campaignId,{start:now,count:1}); else rate.count++;
    // Bind retries to endpoint purpose and message, not just a caller-supplied UUID.
    const fingerprint=hash(`${revisit?'revisit':'conversation'}:${parsed.data.message}:${parsed.data.expectedVersion}`);
    if(pool){const previous=await pool.query('SELECT request_fingerprint FROM chat_turns WHERE campaign_id=$1 AND client_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]);if(previous.rowCount&&previous.rows[0].request_fingerprint&&previous.rows[0].request_fingerprint!==fingerprint)return c.json({error:'TURN_ID_REUSED'},409);}
    const turnKey = `${current.campaignId}:${parsed.data.clientTurnId}`;
    if(turnFingerprints.has(turnKey)&&turnFingerprints.get(turnKey)!==fingerprint)return c.json({error:'TURN_ID_REUSED'},409);
    turnFingerprints.set(turnKey,fingerprint);
    const localCached = turnCache.get(turnKey); if (localCached) return c.json(localCached);
    if (!config.llmApiKey || !config.llmModel) return c.json({ error: 'LLM_UNAVAILABLE' }, 503);
    if (pool) {
      const existing = await pool.query('SELECT response_json,lease_until FROM chat_turns WHERE campaign_id=$1 AND client_turn_id=$2 AND expires_at>now()', [current.campaignId, parsed.data.clientTurnId]);
      if (existing.rowCount && existing.rows[0].response_json) return c.json(existing.rows[0].response_json);
      if (existing.rowCount && existing.rows[0].lease_until && new Date(existing.rows[0].lease_until).getTime() > Date.now()) return c.json({ error: 'TURN_IN_PROGRESS' }, 409);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE', [current.campaignId]);
        const lockedState = await client.query('SELECT game_state,active_chat_until FROM campaigns WHERE id=$1', [current.campaignId]);
        if (lockedState.rows[0]?.active_chat_until && new Date(lockedState.rows[0].active_chat_until).getTime() > Date.now()) { await client.query('ROLLBACK'); return c.json({ error: 'TURN_IN_PROGRESS' }, 409); }
        if ((lockedState.rows[0]?.game_state as GameState | undefined)?.version !== parsed.data.expectedVersion) { await client.query('ROLLBACK'); return c.json({ error: 'VERSION_CONFLICT' }, 409); }
        const reserved = await client.query(`INSERT INTO chat_turns(id,campaign_id,scene_id,prompt_version,model_id,client_turn_id,user_message,lease_until) VALUES($1,$2,$3,'mira-v8-recall-roles',$4,$5,$6,now()+interval '5 minutes') ON CONFLICT(campaign_id,client_turn_id) DO UPDATE SET lease_until=excluded.lease_until,user_message=excluded.user_message WHERE chat_turns.response_json IS NULL AND (chat_turns.lease_until IS NULL OR chat_turns.lease_until<now()) RETURNING client_turn_id`, [randomUUID(), current.campaignId, current.state.sceneId, config.llmModel, parsed.data.clientTurnId, parsed.data.message]);
        if (!reserved.rowCount) { await client.query('COMMIT'); return c.json({ error: 'TURN_IN_PROGRESS' },409); }
        const bound=await client.query('UPDATE chat_turns SET request_fingerprint=$3 WHERE campaign_id=$1 AND client_turn_id=$2 AND (request_fingerprint IS NULL OR request_fingerprint=$3) RETURNING id',[current.campaignId,parsed.data.clientTurnId,fingerprint]);
        if(!bound.rowCount){await client.query('ROLLBACK');return c.json({error:'TURN_ID_REUSED'},409);}
        await client.query('UPDATE campaigns SET active_chat_turn_id=$2,active_chat_until=now()+interval \'5 minutes\' WHERE id=$1', [current.campaignId,parsed.data.clientTurnId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    if (!pool && (localTurnInFlight.has(turnKey) || localCampaignInFlight.has(current.campaignId))) return c.json({ error: 'TURN_IN_PROGRESS' },409);
    if (!pool) { localTurnInFlight.add(turnKey); localCampaignInFlight.add(current.campaignId); }
    let remembered: Awaited<ReturnType<typeof recallVerifiedFacts>>;
    try {
      await onStage?.('recalling');
      remembered = await recallVerifiedFacts(current,parsed.data.message);
      if (remembered.status === 'unavailable') throw new Error('MEMORY_UNAVAILABLE');
      if(revisit&&!remembered.facts.length){
        if(pool){await pool.query('UPDATE chat_turns SET lease_until=NULL WHERE campaign_id=$1 AND client_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]);await pool.query('UPDATE campaigns SET active_chat_turn_id=NULL,active_chat_until=NULL WHERE id=$1 AND active_chat_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]);}
        else {localTurnInFlight.delete(turnKey);localCampaignInFlight.delete(current.campaignId);}
        return c.json({available:false,memoryStatus:remembered.status});
      }
    } catch {
      if (pool) {
        await pool.query('UPDATE chat_turns SET lease_until=NULL WHERE campaign_id=$1 AND client_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]);
        await pool.query('UPDATE campaigns SET active_chat_turn_id=NULL,active_chat_until=NULL WHERE id=$1 AND active_chat_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]);
      } else { localTurnInFlight.delete(turnKey); localCampaignInFlight.delete(current.campaignId); }
      return c.json({ error: 'MEMORY_UNAVAILABLE' },503);
    }
    try {
      await onStage?.('thinking');
      const visitId=c.req.header('x-last-light-visit') ?? 'legacy';
      if(!/^[a-zA-Z0-9-]{1,64}$/.test(visitId))throw new Error('INVALID_VISIT');
      const visitKey=`${current.campaignId}:${hash(token!)}:${visitId}`;
      for(const [key,visit] of visits)if(visit.expires<Date.now())visits.delete(key);
      const recentTurns=visits.get(visitKey)?.turns??[];
      const {response,proposal,candidateMessage,pendingCorrection} = await inferChatTurn(current.state.sceneId, parsed.data.message, remembered.facts,{state:current.state,recentTurns:revisit?[]:recentTurns,purpose:revisit?'revisit':'conversation',coordination:'coordination' in remembered?remembered.coordination:undefined},!!pool&&!revisit,revisit?undefined:visits.get(visitKey)?.pendingCorrection);
      const responseWithStatus = { ...response, memoryStatus: remembered.status, ...('selectedMemoryIds' in remembered ? {memoryEvidence:{retrievedMemoryIds:remembered.retrievedMemoryIds,selectedMemoryIds:remembered.selectedMemoryIds,selectedBlobIds:remembered.selectedBlobIds,calls:remembered.calls,durationMs:remembered.durationMs,candidateCount:remembered.candidateCount,omittedCandidateCount:remembered.omittedCandidateCount}} : {}) };
      if (pool) {
        const eventId = parsed.data.clientTurnId;
        let candidate: ReturnType<typeof validateCandidateProposal> = null;
        try {
          candidate = proposal ? validateCandidateProposal({ proposal, message: candidateMessage, campaignId: current.campaignId, eventId }) : null;
        } catch { /* failed extraction does not turn into a guessed/scripted memory */ }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (candidate && config.sessionSecret) await queueMemory(client,current,candidate);
          await client.query('UPDATE chat_turns SET response_json=$3,model_id=$4,lease_until=NULL WHERE campaign_id=$1 AND client_turn_id=$2',[current.campaignId,parsed.data.clientTurnId,responseWithStatus,response.llmModel??config.llmModel]);
          await client.query('UPDATE campaigns SET active_chat_turn_id=NULL,active_chat_until=NULL WHERE id=$1 AND active_chat_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
      turnCache.set(turnKey,responseWithStatus);
      if(!revisit)visits.set(visitKey,{turns:[...recentTurns,{player:parsed.data.message,mira:response.dialogue}].slice(-4),expires:Date.now()+30*60_000,pendingCorrection});
      return c.json(responseWithStatus);
    } catch (error) {
      // Only expose known internal error codes, never upstream bodies/prompts.
      const safeCode=error instanceof Error&&/^(?:NINE_ROUTER_|REQUESTY_|GROUNDING_|MIRA_|INVALID_LLM_|LLM_|GEMINI_)[A-Za-z0-9_]+$/.test(error.message)?error.message:'UNCLASSIFIED';
      console.error('Mira provider failure:',error instanceof Error?error.name:'unknown',safeCode);
      if (pool) { await pool.query('UPDATE chat_turns SET lease_until=NULL WHERE campaign_id=$1 AND client_turn_id=$2', [current.campaignId, parsed.data.clientTurnId]); await pool.query('UPDATE campaigns SET active_chat_turn_id=NULL,active_chat_until=NULL WHERE id=$1 AND active_chat_turn_id=$2',[current.campaignId,parsed.data.clientTurnId]); }
      if((error as {status?:number}).status===429){
        const seconds=Math.min(3600,Math.max(30,(error as {retryAfterSeconds?:number}).retryAfterSeconds??60));
        c.header('Retry-After',String(seconds));return c.json({error:'LLM_RATE_LIMITED',retryAfterSeconds:seconds},503);
      }
      return c.json({ error: 'LLM_REPLY_FAILED' }, 502);
    } finally { if (!pool) { localTurnInFlight.delete(turnKey); localCampaignInFlight.delete(current.campaignId); } }
  };
  app.post('/api/revisit',c=>chatHandler(c,undefined,true));
  app.post('/api/chat',async(c)=>{
    if(!c.req.header('accept')?.includes('text/event-stream'))return chatHandler(c);
    return streamSSE(c,async(stream)=>{
      await stream.writeSSE({event:'accepted',data:'{}'});
      const result=await chatHandler(c,async(stage)=>{if(!stream.aborted)await stream.writeSSE({event:stage,data:'{}'});});
      if(!stream.aborted)await stream.writeSSE({event:result.status<400?'reply':'error',data:JSON.stringify(await result.json())});
    });
  });
  registerCooperation(app,{db:pool,session:c=>loadSession(cookieToken(c)),queue:queueMemory});
  if(process.env.NODE_ENV==='production'){
    app.get('/assets/*',serveStatic({root:'./dist'}));
    app.get('*',serveStatic({path:'./dist/index.html'}));
  }
  return app;
}

const app = createApp();
export { app, sessions, createApp };

if (process.env.NODE_ENV !== 'test' && process.env.LAST_LIGHT_NO_LISTEN !== '1') {
  const port = Number(process.env.PORT ?? config.port);
  if (pool) await migrate();
  serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (info) => console.log(`LAST LIGHT API listening on port ${info.port}`));
}

