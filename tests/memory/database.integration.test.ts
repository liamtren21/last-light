import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
const transport=vi.hoisted(()=>({remember:vi.fn(),waitForRememberJob:vi.fn(),recall:vi.fn(),destroy:vi.fn()}));
vi.mock('../../server/memory/adapter',async(importOriginal)=>({...await importOriginal<object>(),createMemWal:()=>transport}));
import {pool,migrate} from '../../server/db';
import {app} from '../../server/index';
import {processMemoryJob} from '../../server/memory/worker';
import {encryptPayload} from '../../server/memory/crypto';
import {initialState} from '../../src/game/story';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const uuid=()=>crypto.randomUUID();
async function seedJob(options:{status?:'queued'|'accepted'|'pending_unknown';jobId?:string;factKeyHash?:string;leaseExpired?:boolean;withSession?:boolean}={}){
  const userId=uuid(),campaignId=uuid(),memoryId=uuid(),token=uuid(),eventId=uuid();
  await pool!.query('INSERT INTO users(id) VALUES($1)',[userId]);
  await pool!.query('INSERT INTO campaigns(id,user_id,game_state) VALUES($1,$2,$3)',[campaignId,userId,initialState()]);
  if(options.withSession)await pool!.query('INSERT INTO sessions(token_hash,user_id,campaign_id,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',[createHash('sha256').update(token).digest('hex'),userId,campaignId]);
  const payload=JSON.stringify({schemaVersion:1,memoryId,campaignId,characterId:'mira',kind:'preference',factKey:'identity.name',revision:1,text:'Call me Rowan',source:{type:'user',id:eventId},occurredAt:new Date().toISOString()});
  await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,fact_key_hash,revision,namespace,payload_ciphertext,status,job_id,lease_until,next_attempt_at) VALUES($1,$2,$3,'mira',$4,1,$5,$6,$7,$8,$9,now())",[memoryId,userId,campaignId,options.factKeyHash??'qa-name',`qa-${memoryId}`,encryptPayload(payload),options.status??'queued',options.jobId??null,options.leaseExpired?new Date(Date.now()-60_000):null]);
  await pool!.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,pending_revision) VALUES($1,'mira',$2,0,1)",[campaignId,options.factKeyHash??'qa-name']);
  return {userId,campaignId,memoryId,payload,token,cookie:`last_light_session=${token}`};
}
type WorkerMessage={type:'ready'|'remember'|'poll'|'done';worked?:boolean;receiptRequested?:boolean;jobId?:string};
function startFixtureWorker(payload:string,mode:'hold'|'complete',blobId:string,jobId:string){
  const child=fork(resolve('scripts/memory-worker-process-child.ts'),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],env:process.env});
  const messages:WorkerMessage[]=[],observed:WorkerMessage[]=[];const waiters:Array<{test:(message:WorkerMessage)=>boolean;resolve:(message:WorkerMessage)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>=[];
  child.on('message',(value)=>{const message=value as WorkerMessage;observed.push(message);const index=waiters.findIndex(waiter=>waiter.test(message));if(index>=0){const [waiter]=waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message);}else messages.push(message);});
  child.on('error',(error)=>{for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(error);}});
  const waitFor=(test:(message:WorkerMessage)=>boolean,ms=10000)=>{
    const index=messages.findIndex(test);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]!);
    return new Promise<WorkerMessage>((resolve,reject)=>{const waiter={test,resolve,reject,timer:setTimeout(()=>{const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);reject(new Error('WORKER_FIXTURE_TIMEOUT'));},ms)};waiters.push(waiter);});
  };
  const ready=waitFor(message=>message.type==='ready').then(()=>child.send({type:'run',payload,mode,blobId,jobId}));
  return {child,waitFor,ready,messages,observed};
}
async function childDone(worker:ReturnType<typeof startFixtureWorker>){await worker.ready;const done=await worker.waitFor(message=>message.type==='done');const exited=new Promise<void>(resolveExit=>worker.child.once('exit',()=>resolveExit()));await exited;return done;}
describe.skipIf(!process.env.LAST_LIGHT_DATABASE_TEST)('real PostgreSQL memory lifecycle with simulated relayer',()=>{
  beforeEach(()=>vi.resetAllMocks());
  beforeAll(async()=>{await migrate();});afterAll(async()=>{await pool?.end();});
  it('survives worker process kill, durable lease exclusion and concurrent lease reclaim without resubmitting',async()=>{
    await pool!.query("UPDATE memory_outbox SET next_attempt_at='infinity' WHERE status IN ('queued','accepted','pending_unknown')");
    const fixture=await seedJob();const jobId=`fixture-job-${uuid()}`,blobId=`fixture-blob-${uuid()}`;
    const first=startFixtureWorker(fixture.payload,'hold',blobId,jobId);await first.ready;
    await first.waitFor(message=>message.type==='remember');await first.waitFor(message=>message.type==='poll');
    const persisted=await pool!.query('SELECT status,job_id,lease_until>now() AS leased FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId]);
    expect(persisted.rows[0]).toEqual({status:'accepted',job_id:jobId,leased:true});
    first.child.kill('SIGKILL');await new Promise<void>(resolveExit=>first.child.once('exit',()=>resolveExit()));

    const restart=startFixtureWorker(fixture.payload,'complete',blobId,jobId);const restartResult=await childDone(restart);
    expect(restartResult.worked).toBe(false);
    expect((await pool!.query('SELECT status,job_id,attempts FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toEqual({status:'accepted',job_id:jobId,attempts:1});

    await pool!.query('UPDATE memory_outbox SET lease_until=now()-interval \'1 second\',next_attempt_at=now() WHERE memory_id=$1',[fixture.memoryId]);
    const [claimant,contender]=[startFixtureWorker(fixture.payload,'complete',blobId,jobId),startFixtureWorker(fixture.payload,'complete',blobId,jobId)];
    await Promise.all([claimant.ready,contender.ready]);
    const results=await Promise.all([childDone(claimant),childDone(contender)]);
    expect(results.filter(result=>result.worked)).toHaveLength(1);
    expect(results.filter(result=>!result.worked)).toHaveLength(1);
    const rememberCalls=[first,restart,claimant,contender].reduce((count,worker)=>count+worker.observed.filter(message=>message.type==='remember').length,0);
    expect(rememberCalls).toBe(1);
    expect((await pool!.query('SELECT status,job_id,attempts,lease_until FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toMatchObject({status:'confirmed',job_id:jobId,attempts:2,lease_until:null});
    expect((await pool!.query('SELECT blob_id,checksum,recall_verified_at IS NOT NULL AS recalled FROM memory_receipts WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toMatchObject({blob_id:blobId,recalled:true});
    const evidence={createdAt:new Date().toISOString(),scope:'dedicated local PostgreSQL; separate Node worker processes; injected fixture transport; no live MemWal requests',processesStarted:4,forcedProcessKills:1,simulatedAcceptedWrites:rememberCalls,workerRememberCalls:rememberCalls,acceptedJobPersistenceSurvivedKill:true,leasePreventedEarlyRestart:true,expiredLeaseClaimedOnce:true,concurrentWorkersWithSingleClaim:true,restartDidNotResubmit:rememberCalls===1,receiptRoundTripVerified:true,finalStatus:'confirmed',mainnetProof:false};
    await mkdir('verification',{recursive:true});await writeFile('verification/worker-process-stress.json',JSON.stringify(evidence,null,2)+'\n');
  });
  it('persists accepted job, verifies receipt, clears payload and excludes forgotten facts',async()=>{
    const session=await app.request('/api/session',{method:'POST'});const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
    const token=cookie.slice(cookie.indexOf('=')+1);
    const user=await pool!.query('SELECT campaign_id AS id,user_id FROM sessions WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')]);const campaignId=user.rows[0].id;
    const memoryId=uuid();const payload=JSON.stringify({schemaVersion:1,memoryId,campaignId,characterId:'mira',kind:'preference',factKey:'identity.name',revision:1,text:'Call me Rowan',source:{type:'user',id:uuid()},occurredAt:new Date().toISOString()});
    await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,fact_key_hash,revision,namespace,payload_ciphertext,status) VALUES($1,$2,$3,'mira',$4,1,$5,$6,'queued')",[memoryId,user.rows[0].user_id,campaignId,'name-hash',`qa-${memoryId}`,encryptPayload(payload)]);
    const job=`job-${memoryId}`;const blob=`blob-${memoryId}`;
    transport.remember.mockResolvedValue({job_id:job});transport.waitForRememberJob.mockImplementation(async()=>{
      expect((await pool!.query('SELECT job_id FROM memory_outbox WHERE memory_id=$1',[memoryId])).rows[0].job_id).toBe(job);return {blob_id:blob};
    });transport.recall.mockResolvedValue({results:[{blob_id:blob,text:payload}]});
    expect(await processMemoryJob()).toBe(true);
    const saved=(await pool!.query('SELECT status,payload_ciphertext FROM memory_outbox WHERE memory_id=$1',[memoryId])).rows[0];expect(saved).toEqual({status:'confirmed',payload_ciphertext:''});
    expect((await pool!.query('SELECT memory_kind FROM memory_outbox WHERE memory_id=$1',[memoryId])).rows[0].memory_kind).toBe('preference');
    expect((await pool!.query('SELECT active_memory_id FROM fact_heads WHERE campaign_id=$1',[campaignId])).rows[0].active_memory_id).toBe(memoryId);
    const forget=await app.request('/api/memories/forget',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({memoryId})});expect(forget.status).toBe(200);
    expect((await pool!.query('SELECT reason FROM memory_tombstones WHERE campaign_id=$1',[campaignId])).rows[0].reason).toBe('player-request');
  });
  it('unknown acceptance never issues a second paid write',async()=>{
    const userId=uuid(),campaignId=uuid(),memoryId=uuid();
    await pool!.query('INSERT INTO users(id) VALUES($1)',[userId]);await pool!.query('INSERT INTO campaigns(id,user_id,game_state) VALUES($1,$2,$3)',[campaignId,userId,initialState()]);
    const payload=JSON.stringify({memoryId,text:'fictional QA'});
    await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,fact_key_hash,revision,namespace,payload_ciphertext,status) VALUES($1,$2,$3,'mira',$4,1,$5,$6,'pending_unknown')",[memoryId,userId,campaignId,'qa',`qa-${memoryId}`,encryptPayload(payload)]);
    transport.remember.mockClear();transport.recall.mockResolvedValue({results:[]});
    await processMemoryJob();expect(transport.remember).not.toHaveBeenCalled();
    expect((await pool!.query('SELECT status,error_code FROM memory_outbox WHERE memory_id=$1',[memoryId])).rows[0]).toEqual({status:'pending_unknown',error_code:'RECONCILIATION_REQUIRED'});
  });

  it('restarts an accepted job after polling timeout without submitting a second write',async()=>{
    const fixture=await seedJob();
    const job=`job-${uuid()}`;
    const blob=`blob-${uuid()}`;
    transport.remember.mockResolvedValue({job_id:job});
    transport.waitForRememberJob.mockRejectedValueOnce(new Error('poll timeout')).mockResolvedValueOnce({blob_id:blob});
    transport.recall.mockResolvedValue({results:[{blob_id:blob,text:fixture.payload}]});
    await processMemoryJob();
    expect((await pool!.query('SELECT status,job_id FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toEqual({status:'accepted',job_id:job});
    await pool!.query('UPDATE memory_outbox SET next_attempt_at=now() WHERE memory_id=$1',[fixture.memoryId]);
    await processMemoryJob();
    expect(transport.remember).toHaveBeenCalledOnce();
    expect(transport.waitForRememberJob).toHaveBeenNthCalledWith(1,job,{timeoutMs:60_000});
    expect(transport.waitForRememberJob).toHaveBeenNthCalledWith(2,job,{timeoutMs:60_000});
    expect((await pool!.query('SELECT status FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0].status).toBe('confirmed');
  });

  it('stops retrying terminal auth failures and reclaims an expired worker lease',async()=>{
    const fixture=await seedJob({leaseExpired:true});
    transport.remember.mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    expect(await processMemoryJob()).toBe(true);
    expect((await pool!.query('SELECT status,attempts,error_code FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toMatchObject({status:'failed',attempts:1,error_code:'HTTP 401 Unauthorized'});
    expect(await processMemoryJob()).toBe(false);
    expect(transport.remember).toHaveBeenCalledOnce();
  });

  it('retains an accepted job even if its first database persistence fails',async()=>{
    const fixture=await seedJob();const job=`qa-${uuid()}`;
    transport.remember.mockResolvedValue({job_id:job});
    const original=pool!.query.bind(pool);let interrupted=false;
    const spy=vi.spyOn(pool!,'query').mockImplementation(((...args:unknown[])=>{
      if(!interrupted&&typeof args[0]==='string'&&args[0].includes("status='accepted',job_id=$2")){interrupted=true;throw new Error('temporary database interruption');}
      return (original as (...parameters:unknown[])=>unknown)(...args);
    }) as NonNullable<typeof pool>['query']);
    try{await processMemoryJob();}finally{spy.mockRestore();}
    expect(interrupted).toBe(true);expect(transport.remember).toHaveBeenCalledOnce();
    expect((await pool!.query('SELECT status,job_id FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toEqual({status:'accepted',job_id:job});
    await pool!.query("UPDATE memory_outbox SET next_attempt_at='infinity' WHERE memory_id=$1",[fixture.memoryId]);
  });

  it('does not submit a queued memory already forgotten by the player',async()=>{
    const fixture=await seedJob();
    await pool!.query("INSERT INTO memory_tombstones(campaign_id,character_id,fact_key_hash,reason) VALUES($1,'mira','qa-name','player-request')",[fixture.campaignId]);
    await processMemoryJob();
    expect(transport.remember).not.toHaveBeenCalled();
    expect((await pool!.query('SELECT status,error_code,payload_ciphertext FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toEqual({status:'failed',error_code:'MEMORY_FORGOTTEN',payload_ciphertext:''});
    expect((await pool!.query('SELECT active_memory_id FROM fact_heads WHERE campaign_id=$1',[fixture.campaignId])).rows[0].active_memory_id).toBeNull();
  });

  it('keeps an in-flight forgotten write confirmed but never activates its revision',async()=>{
    const fixture=await seedJob({withSession:true});
    const blob=`blob-${uuid()}`;
    let markWaiting!:()=>void;const waiting=new Promise<void>(resolve=>{markWaiting=resolve;});
    let finish!: (value:{blob_id:string})=>void;const receipt=new Promise<{blob_id:string}>(resolve=>{finish=resolve;});
    transport.remember.mockResolvedValue({job_id:`job-${uuid()}`});
    transport.waitForRememberJob.mockImplementation(async()=>{markWaiting();return receipt;});
    transport.recall.mockResolvedValue({results:[{blob_id:blob,text:fixture.payload}]});
    const processing=processMemoryJob();await waiting;
    const forgotten=await app.request('/api/memories/forget',{method:'POST',headers:{cookie:fixture.cookie,'content-type':'application/json'},body:JSON.stringify({memoryId:fixture.memoryId})});
    expect(forgotten.status).toBe(200);
    finish({blob_id:blob});await processing;
    expect((await pool!.query('SELECT status FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0].status).toBe('confirmed');
    expect((await pool!.query('SELECT active_memory_id FROM fact_heads WHERE campaign_id=$1',[fixture.campaignId])).rows[0].active_memory_id).toBeNull();
    expect((await pool!.query('SELECT reason FROM memory_tombstones WHERE campaign_id=$1',[fixture.campaignId])).rows[0].reason).toBe('player-request');
  });

  it('the retry API refuses ambiguous writes, forgotten notes and other campaigns',async()=>{
    const fixture=await seedJob({withSession:true});
    await pool!.query("UPDATE memory_outbox SET status='failed',error_code='network timeout',next_attempt_at='infinity' WHERE memory_id=$1",[fixture.memoryId]);
    const retry=()=>app.request('/api/memories/retry',{method:'POST',headers:{cookie:fixture.cookie,'content-type':'application/json'},body:JSON.stringify({memoryId:fixture.memoryId})});
    expect((await retry()).status).toBe(409);
    await pool!.query("UPDATE memory_outbox SET error_code='HTTP 401 Unauthorized' WHERE memory_id=$1",[fixture.memoryId]);
    const outsider=await app.request('/api/session',{method:'POST'});const cookie=outsider.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/api/memories/retry',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({memoryId:fixture.memoryId})})).status).toBe(409);
    await pool!.query("INSERT INTO memory_tombstones(campaign_id,character_id,fact_key_hash,reason) VALUES($1,'mira','qa-name','player-request')",[fixture.campaignId]);
    expect((await retry()).status).toBe(409);
  });

  it('the retry API keeps a known job ID and never requeues a terminal failed job',async()=>{
    const jobId=`qa-existing-${uuid()}`;const fixture=await seedJob({withSession:true,status:'accepted',jobId});
    await pool!.query("UPDATE memory_outbox SET status='failed',error_code='poll timeout',attempts=8,next_attempt_at='infinity' WHERE memory_id=$1",[fixture.memoryId]);
    const retry=()=>app.request('/api/memories/retry',{method:'POST',headers:{cookie:fixture.cookie,'content-type':'application/json'},body:JSON.stringify({memoryId:fixture.memoryId})});
    expect((await retry()).status).toBe(200);
    expect((await pool!.query('SELECT status,job_id,attempts FROM memory_outbox WHERE memory_id=$1',[fixture.memoryId])).rows[0]).toEqual({status:'accepted',job_id:jobId,attempts:0});
    await pool!.query("UPDATE memory_outbox SET status='failed',error_code='job status failed',next_attempt_at='infinity' WHERE memory_id=$1",[fixture.memoryId]);
    expect((await retry()).status).toBe(409);
  });
});
