import {beforeEach,expect,it,vi} from 'vitest';
import {recallEngineEpisodes,episodesStillActive} from '../../server/memory/episode-recall';
import {checksum} from '../../server/memory/adapter';
import {factHash} from '../../server/memory/scope';
const session={userId:'00000000-0000-4000-8000-000000000001',campaignId:'00000000-0000-4000-8000-000000000002'};
const id='00000000-0000-4000-8000-000000000003';
beforeEach(()=>{process.env.SESSION_SECRET='episode-recall-test-secret-at-least-32-characters';});
function fixture(overrides:Record<string,unknown>={}) {
 const text=JSON.stringify({schemaVersion:1,memoryId:id,campaignId:session.campaignId,characterId:'mira',kind:'episode',factKey:'episode.'+id,revision:1,text:'We checked all six names under the roof.',source:{type:'game',id:'action'},occurredAt:new Date().toISOString(),...overrides});
 const head={memory_id:id,active_revision:1,fact_key_hash:factHash('episode.'+id),blob_id:'blob',checksum:checksum(text)};
 const query=vi.fn().mockResolvedValue({rows:[head]});const transport={recall:vi.fn().mockResolvedValue({results:[{blob_id:'blob',text}]}),destroy:vi.fn()};
 return {head,query,transport,input:{db:{query},session,query:'our handoff',createTransport:()=>transport}};
}
it('uses remote content, exact receipt and rechecks active revision',async()=>{
 const f=fixture();const r=await recallEngineEpisodes(f.input);expect(r.status).toBe('recalled');expect(r.selectedMemoryIds).toEqual([id]);expect(r.facts[0]).toContain('Engine-confirmed recalled event');expect(f.query).toHaveBeenCalledTimes(2);expect(f.transport.destroy).toHaveBeenCalledOnce();
});
it.each([{campaignId:'00000000-0000-4000-8000-000000000009'},{source:{type:'user',id:'claim'}},{revision:2},{expiresAt:'2020-01-01T00:00:00.000Z'}])('rejects foreign, user-claimed, superseded and expired content %j',async overrides=>{
 const f=fixture(overrides);expect((await recallEngineEpisodes(f.input)).facts).toEqual([]);
});
it('does not use corrupted bytes or a dropped response',async()=>{
 const f=fixture();f.transport.recall.mockResolvedValue({results:[{blob_id:'blob',text:'invalid'}]});expect((await recallEngineEpisodes(f.input)).status).toBe('unavailable');
});
it('suppresses an episode forgotten while recall is running',async()=>{
 const f=fixture();f.query.mockResolvedValueOnce({rows:[f.head]}).mockResolvedValueOnce({rows:[]});expect((await recallEngineEpisodes(f.input)).facts).toEqual([]);
});
it('optional timeout adds no local-memory fallback',async()=>{
 const f=fixture();f.transport.recall.mockImplementation(()=>new Promise(()=>{}));expect((await recallEngineEpisodes({...f.input,timeoutMs:5})).status).toBe('unavailable');expect(f.transport.destroy).toHaveBeenCalledOnce();
});
it('checks suppression again after LLM latency',async()=>{
 const f=fixture();f.query.mockResolvedValue({rows:[]});expect(await episodesStillActive({query:f.query},session,[id])).toBe(false);expect(await episodesStillActive({query:f.query},session,[])).toBe(true);
});
