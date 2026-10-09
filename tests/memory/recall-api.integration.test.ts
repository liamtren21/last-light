import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
const transport=vi.hoisted(()=>({recall:vi.fn(),destroy:vi.fn()}));
const provider=vi.hoisted(()=>({reply:vi.fn(),extract:vi.fn()}));
vi.mock('../../server/llm/gemini',()=>({generateMiraReply:provider.reply,proposeMiraMemory:provider.extract}));
vi.mock('../../server/memory/adapter',async(importOriginal)=>({...await importOriginal<object>(),createMemWal:()=>transport}));
import {pool,migrate} from '../../server/db';
import {config} from '../../server/config';
import {app,recallVerifiedFacts} from '../../server/index';
import {checksum} from '../../server/memory/adapter';
import {factHash} from '../../server/memory/scope';
import {opaqueNamespace} from '../../server/memory/scope';
import {createHash} from 'node:crypto';
import {initialState} from '../../src/game/story';

describe.skipIf(!process.env.LAST_LIGHT_DATABASE_TEST)('API recall against PostgreSQL metadata and simulated Walrus',()=>{
  const original={memwalAccountId:config.memwalAccountId,memwalDelegateKey:config.memwalDelegateKey,memwalRelayerUrl:config.memwalRelayerUrl,llmApiKey:config.llmApiKey,llmModel:config.llmModel};
  beforeAll(async()=>{await migrate();Object.assign(config,{memwalAccountId:'fixture-account',memwalDelegateKey:'fixture-not-a-key',memwalRelayerUrl:'https://fixture.invalid'});});
  beforeEach(()=>vi.resetAllMocks());
  afterAll(async()=>{Object.assign(config,original);await pool?.end();});
  async function seed(count=1){
    const userId=crypto.randomUUID(),campaignId=crypto.randomUUID();
    await pool!.query('INSERT INTO users(id) VALUES($1)',[userId]);
    await pool!.query('INSERT INTO campaigns(id,user_id,game_state) VALUES($1,$2,$3)',[campaignId,userId,initialState()]);
    const items=[];
    for(let n=0;n<count;n++){
      const memoryId=crypto.randomUUID(),namespace=`fixture-${memoryId}`,blobId=`blob-${memoryId}`,jobId=`job-${memoryId}`,key=n===0?'identity.name':`episode.${memoryId}`;
      const payload=JSON.stringify({schemaVersion:1,memoryId,campaignId,characterId:'mira',kind:n===0?'preference':'episode',factKey:key,revision:1,text:n===0?'Call me Rowan':`Witnessed the coast ${n}`,source:{type:'user',id:crypto.randomUUID()},occurredAt:new Date().toISOString()});
      await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,fact_key_hash,revision,namespace,payload_ciphertext,status,job_id) VALUES($1,$2,$3,'mira',$4,1,$5,'','confirmed',$6)",[memoryId,userId,campaignId,factHash(key),namespace,jobId]);
      await pool!.query('INSERT INTO memory_receipts(memory_id,job_id,blob_id,checksum,recall_verified_at) VALUES($1,$2,$3,$4,now())',[memoryId,jobId,blobId,checksum(payload)]);
      await pool!.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,active_memory_id) VALUES($1,'mira',$2,1,$3)",[campaignId,factHash(key),memoryId]);
      items.push({memoryId,namespace,blobId,payload,key});
    }
    return {userId,campaignId,items};
  }
  it('gets text from remote recall and exposes capped retrieval evidence',async()=>{
    const fixture=await seed(18);
    transport.recall.mockImplementation(async({namespace}:{namespace:string})=>{const item=fixture.items.find(item=>item.namespace===namespace)!;return {results:[{blob_id:item.blobId,text:item.payload}]};});
    const result=await recallVerifiedFacts(fixture,'Who am I?');
    expect(result.status).toBe('recalled');expect(result.facts[0]).toContain('Call me Rowan');
    expect(result).toMatchObject({calls:16,candidateCount:16,omittedCandidateCount:2});
    // One request-scoped SDK client shares its session/compatibility handshake.
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(result.facts).toHaveLength(12);
  });
  it('suppresses a pending correction before contacting remote recall',async()=>{
    const fixture=await seed();await pool!.query('UPDATE fact_heads SET pending_revision=2 WHERE campaign_id=$1',[fixture.campaignId]);
    const result=await recallVerifiedFacts(fixture,'Who am I?');
    expect(result).toMatchObject({status:'empty',facts:[],calls:0});expect(transport.recall).not.toHaveBeenCalled();
  });
  it('retains an older dynamically keyed preference ahead of newer episodes',async()=>{
    const fixture=await seed(18),item=fixture.items[0]!;
    const payload=JSON.stringify({...JSON.parse(item.payload),factKey:'preference.quiet',text:'I prefer quiet crossings'});
    await pool!.query("UPDATE memory_outbox SET fact_key_hash=$2,memory_kind='preference',created_at=now()-interval '30 days' WHERE memory_id=$1",[item.memoryId,factHash('preference.quiet')]);
    await pool!.query('UPDATE fact_heads SET fact_key_hash=$2 WHERE active_memory_id=$1',[item.memoryId,factHash('preference.quiet')]);
    await pool!.query('UPDATE memory_receipts SET checksum=$2 WHERE memory_id=$1',[item.memoryId,checksum(payload)]);
    item.payload=payload;
    transport.recall.mockImplementation(async({namespace}:{namespace:string})=>{const match=fixture.items.find(value=>value.namespace===namespace)!;return {results:[{blob_id:match.blobId,text:match.payload}]};});
    const result=await recallVerifiedFacts(fixture,'What do I prefer?');
    expect(result).toMatchObject({status:'recalled',calls:16,omittedCandidateCount:2});
    expect(result.facts[0]).toContain('quiet crossings');
  });
  it('does not use a fact forgotten while its remote recall was in flight',async()=>{
    const fixture=await seed(),item=fixture.items[0]!;
    transport.recall.mockImplementation(async()=>{
      await pool!.query("INSERT INTO memory_tombstones(campaign_id,character_id,fact_key_hash,reason) VALUES($1,'mira',$2,'fixture-forget')",[fixture.campaignId,factHash(item.key)]);
      return {results:[{blob_id:item.blobId,text:item.payload}]};
    });
    const result=await recallVerifiedFacts(fixture,'Who am I?');
    expect(result).toMatchObject({status:'unavailable',facts:[],selectedMemoryIds:[]});
  });
  it('rejects modified remote text instead of rebuilding it from save/outbox',async()=>{
    const fixture=await seed(),item=fixture.items[0]!;
    transport.recall.mockResolvedValue({results:[{blob_id:item.blobId,text:item.payload.replace('Rowan','Someone else')}]});
    expect(await recallVerifiedFacts(fixture,'Who am I?')).toMatchObject({status:'unavailable',facts:[]});
  });
  it('finds an old episode by shared-namespace semantic recall ahead of recent unrelated events',async()=>{
    const fixture=await seed(20),target=fixture.items[19]!,namespace=opaqueNamespace(fixture.userId,fixture.campaignId);
    await pool!.query('UPDATE memory_outbox SET namespace=$2,memory_kind=\'episode\' WHERE campaign_id=$1',[fixture.campaignId,namespace]);
    transport.recall.mockResolvedValue({results:[{blob_id:target.blobId,text:target.payload,distance:0.01}],total:20});
    const result=await recallVerifiedFacts(fixture,'the coast 19');
    expect(result.status).toBe('recalled');expect(result.facts[0]).toContain('coast 19');
    expect(transport.recall).toHaveBeenCalledOnce();expect(result).toMatchObject({calls:1,selectedMemoryIds:[target.memoryId]});
  });
  it('revisit uses verified memory with an empty transcript and never extracts the synthetic greeting request',async()=>{
    const fixture=await seed(),item=fixture.items[0]!,token=crypto.randomUUID();
    await pool!.query('INSERT INTO sessions(token_hash,user_id,campaign_id,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',[createHash('sha256').update(token).digest('hex'),fixture.userId,fixture.campaignId]);
    config.llmApiKey='fixture';config.llmModel='fixture';
    transport.recall.mockResolvedValue({results:[{blob_id:item.blobId,text:item.payload}]});
    provider.reply.mockResolvedValue({dialogue:'Rowan, you came back. Shall we check the route?',expression:'attentive',proposedAction:null});
    const turnId=crypto.randomUUID(),body=JSON.stringify({clientTurnId:turnId,expectedVersion:0});
    const request=()=>app.request('/api/revisit',{method:'POST',headers:{cookie:`last_light_session=${token}`,'content-type':'application/json'},body});
    expect((await request()).status).toBe(200);
    expect(provider.reply.mock.calls[0]![2][0]).toContain('Rowan');
    expect(provider.reply.mock.calls[0]![3]).toMatchObject({recentTurns:[],purpose:'revisit'});
    expect(provider.extract).not.toHaveBeenCalled();
    await request();expect(provider.reply).toHaveBeenCalledOnce();
    const reused=await app.request('/api/chat',{method:'POST',headers:{cookie:`last_light_session=${token}`,'content-type':'application/json'},body:JSON.stringify({clientTurnId:turnId,expectedVersion:0,message:'A different message'})});
    expect(reused.status).toBe(409);expect((await reused.json()).error).toBe('TURN_ID_REUSED');
    expect((await pool!.query('SELECT COUNT(*) AS count FROM memory_outbox WHERE campaign_id=$1',[fixture.campaignId])).rows[0].count).toBe('1');
  });
});
