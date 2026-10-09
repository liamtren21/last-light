import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checksum } from '../../server/memory/adapter';
import { factHash } from '../../server/memory/scope';
import { retrieveVerifiedMemories, type RecallHead } from '../../server/memory/retrieval';
import type { MemoryEnvelope } from '../../server/memory/extract';

const campaignId = '00000000-0000-4000-8000-000000000001';
const otherCampaignId = '00000000-0000-4000-8000-000000000002';
const characterId = 'mira';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(n: number, options: { kind?: MemoryEnvelope['kind']; text?: string; expiresAt?: string; campaignId?: string; characterId?: 'mira'; factKey?: string } = {}) {
  const envelope: MemoryEnvelope = {
    schemaVersion: 1, memoryId: uuid(n), campaignId: options.campaignId ?? campaignId, characterId: options.characterId ?? characterId,
    kind: options.kind ?? 'promise', factKey: options.factKey ?? `promise.${n}`, revision: 1,
    text: options.text ?? `Keep the map dry, note ${n}.`, source: { type: 'user', id: uuid(n + 1000) },
    occurredAt: '2026-10-02T00:00:00.000Z', ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  };
  const serialized = JSON.stringify(envelope);
  const blobId = `blob-${n}`;
  const head: RecallHead = {
    factKeyHash: factHash(envelope.factKey!), activeRevision: envelope.revision, memoryId: envelope.memoryId,
    namespace: `scope-${n}`, blobId, checksum: checksum(serialized), campaignId: envelope.campaignId,
    characterId: envelope.characterId, kind: envelope.kind,
  };
  return { envelope, serialized, blobId, head, result: { blob_id: blobId, text: serialized } };
}

beforeEach(() => { process.env.SESSION_SECRET = 'retrieval-test-secret-at-least-32-chars'; });

describe('verified memory retrieval', () => {
  it('reads independent namespaces concurrently within the same total budget', async () => {
    vi.useFakeTimers();
    try {
      const fixtures=Array.from({length:4},(_,i)=>fixture(180+i));
      const recall=vi.fn(async(namespace:string)=>{await new Promise(r=>setTimeout(r,40));return {results:[fixtures.find(f=>f.head.namespace===namespace)!.result]};});
      const pending=retrieveVerifiedMemories({heads:fixtures.map(f=>f.head),scope:{campaignId,characterId},query:'plan',recall,destroy:vi.fn(),budget:{totalMs:90,perCallMs:80}});
      await vi.advanceTimersByTimeAsync(95);
      expect((await pending).status).toBe('recalled');
    } finally {vi.useRealTimers();}
  });

  it('reads one shared namespace once but verifies every expected blob',async()=>{
    const one=fixture(190);const two=fixture(191);two.head.namespace=one.head.namespace;
    const recall=vi.fn(async()=>({results:[one.result,two.result]}));const destroy=vi.fn();
    const result=await retrieveVerifiedMemories({heads:[one.head,two.head],scope:{campaignId,characterId},query:'plan',recall,destroy});
    expect(result.selectedMemoryIds).toHaveLength(2);expect(recall).toHaveBeenCalledTimes(1);expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('retries a transient read failure once without accepting unverified text',async()=>{
    const one=fixture(192);let attempt=0;
    const recall=vi.fn(async()=>{if(attempt++===0)throw Object.assign(new Error('temporary'),{status:503});return {results:[one.result]};});
    const result=await retrieveVerifiedMemories({heads:[one.head],scope:{campaignId,characterId},query:'plan',recall,destroy:vi.fn()});
    expect(result.status).toBe('recalled');expect(recall).toHaveBeenCalledTimes(2);
  });

  it('does not retry auth failures or invent partial recall',async()=>{
    const one=fixture(193);const recall=vi.fn(async()=>{throw Object.assign(new Error('unauthorized'),{status:401});});
    const result=await retrieveVerifiedMemories({heads:[one.head],scope:{campaignId,characterId},query:'plan',recall,destroy:vi.fn()});
    expect(result).toMatchObject({status:'unavailable',facts:[]});expect(recall).toHaveBeenCalledTimes(1);
  });

  it('exposes coordination roles only from the verified, selected plan envelope',async()=>{
    const one=fixture(194,{factKey:'cooperation.plan'});
    const serialized=JSON.stringify({...one.envelope,cooperation:{meeting:'shelter',priority:'passengers',reason:'Stay together.',technique:'call-response',cue:'Amber window'}});
    const input={heads:[{...one.head,checksum:checksum(serialized)}],scope:{campaignId,characterId},query:'cue',recall:async()=>({results:[{blob_id:one.blobId,text:serialized}]}),destroy:vi.fn()};
    expect((await retrieveVerifiedMemories(input)).coordination).toEqual({technique:'call-response',cue:'Amber window'});
    expect((await retrieveVerifiedMemories({...input,budget:{selected:0}})).coordination).toBeUndefined();
  });
  it('returns source-aware facts and selected/retrieved instrumentation after exact verification', async () => {
    const one = fixture(1, { kind: 'promise' });
    const two = fixture(2, { kind: 'episode' });
    const recall = vi.fn(async (namespace: string) => ({ results: [namespace === one.head.namespace ? one.result : two.result] }));
    const destroy = vi.fn();
    const result = await retrieveVerifiedMemories({
      heads: [two.head, one.head], scope: { campaignId, characterId }, query: 'meet here', recall, destroy,
    });
    expect(result.status).toBe('recalled');
    expect(result.facts).toEqual([
      'The player said (not proof of completed game actions): Keep the map dry, note 1.',
      'The player said (not proof of completed game actions): Keep the map dry, note 2.',
    ]);
    expect(result.retrievedBlobIds).toEqual(['blob-1', 'blob-2']);
    expect(result.selectedMemoryIds).toEqual([one.head.memoryId, two.head.memoryId]);
    expect(recall).toHaveBeenCalledWith('scope-1', 'meet here', 10);
    expect(destroy.mock.calls.map(([namespace]) => namespace)).toEqual(['scope-1', 'scope-2']);
  });

  it.each([
    ['missing expected blob', (f: ReturnType<typeof fixture>) => [{ blob_id: 'wrong', text: f.serialized }]],
    ['checksum mismatch', (f: ReturnType<typeof fixture>) => [{ blob_id: f.blobId, text: `${f.serialized} ` }]],
    ['schema or envelope identity mismatch', (f: ReturnType<typeof fixture>) => [{ blob_id: f.blobId, text: JSON.stringify({ ...f.envelope, memoryId: 'bad' }) }]],
  ])('fails closed with no partial facts on %s', async (_label, makeResult) => {
    const good = fixture(3); const bad = fixture(4);
    const recall = vi.fn(async (namespace: string) => ({ results: [namespace === good.head.namespace ? good.result : makeResult(bad)[0]!] }));
    const result = await retrieveVerifiedMemories({ heads: [good.head, bad.head], scope: { campaignId, characterId }, query: 'x', recall, destroy: vi.fn() });
    expect(result).toMatchObject({ status: 'unavailable', facts: [], selectedMemoryIds: [] });
  });

  it('rejects campaign, character, revision, memory ID and fact-hash mismatches without leaking text', async () => {
    const base = fixture(5);
    const mismatches: RecallHead[] = [
      { ...base.head, campaignId: otherCampaignId },
      { ...base.head, characterId: 'someone-else' },
      { ...base.head, activeRevision: 2 },
      { ...base.head, memoryId: uuid(99) },
      { ...base.head, factKeyHash: 'wrong-hash' },
    ];
    for (const head of mismatches) {
      const result = await retrieveVerifiedMemories({ heads: [head], scope: { campaignId, characterId }, query: 'x', recall: async () => ({ results: [base.result] }), destroy: vi.fn() });
      expect(result).toMatchObject({ status: 'unavailable', facts: [] });
    }
  });

  it('validates the envelope schema and canonical fact hash after checksum verification', async () => {
    const base = fixture(55);
    const invalidEnvelope = JSON.stringify({ ...base.envelope, memoryId: 'not-a-uuid' });
    const invalidSchemaHead = { ...base.head, checksum: checksum(invalidEnvelope) };
    const invalidSchema = await retrieveVerifiedMemories({ heads: [invalidSchemaHead], scope: { campaignId, characterId }, query: 'x', recall: async () => ({ results: [{ blob_id: base.blobId, text: invalidEnvelope }] }), destroy: vi.fn() });
    expect(invalidSchema).toMatchObject({ status: 'unavailable', facts: [] });

    const otherFact = JSON.stringify({ ...base.envelope, factKey: 'promise.someone-elses-fact' });
    const wrongHashHead = { ...base.head, checksum: checksum(otherFact) };
    const wrongHash = await retrieveVerifiedMemories({ heads: [wrongHashHead], scope: { campaignId, characterId }, query: 'x', recall: async () => ({ results: [{ blob_id: base.blobId, text: otherFact }] }), destroy: vi.fn() });
    expect(wrongHash).toMatchObject({ status: 'unavailable', facts: [] });
  });

  it('skips expired facts and distinguishes an empty result from a failed retrieval', async () => {
    const expired = fixture(6, { expiresAt: '2026-10-01T00:00:00.000Z' });
    const recall = async () => ({ results: [expired.result] });
    const result = await retrieveVerifiedMemories({ heads: [expired.head], scope: { campaignId, characterId }, query: 'x', recall, destroy: vi.fn(), now: Date.parse('2026-10-02T00:00:00.000Z') });
    expect(result).toMatchObject({ status: 'empty', facts: [], retrievedBlobIds: [expired.blobId] });
    const failed = await retrieveVerifiedMemories({ heads: [expired.head], scope: { campaignId, characterId }, query: 'x', recall: async () => { throw new Error('offline'); }, destroy: vi.fn() });
    expect(failed).toMatchObject({ status: 'unavailable', facts: [] });
  });

  it('skips valid oversized context facts without truncating while retaining other verified facts', async () => {
    const oversized = fixture(67, { kind: 'promise', text: 'x'.repeat(501) });
    const short = fixture(68, { kind: 'episode', text: 'The ferry is late.' });
    const fixtures = [oversized, short];
    const result = await retrieveVerifiedMemories({
      heads: fixtures.map((item) => item.head), scope: { campaignId, characterId }, query: 'x', destroy: vi.fn(),
      recall: async (namespace) => { const item = fixtures.find((value) => value.head.namespace === namespace)!; return { results: [item.result] }; },
    });
    expect(result.status).toBe('recalled');
    expect(result.facts).toEqual(['The player said (not proof of completed game actions): The ferry is late.']);
    expect(result.retrievedMemoryIds).toEqual([oversized.head.memoryId, short.head.memoryId]);
    expect(result.selectedMemoryIds).toEqual([short.head.memoryId]);
  });

  it('fails closed for a corrupted oversized payload before considering context length', async () => {
    const oversized = fixture(69, { kind: 'promise', text: 'x'.repeat(501) });
    const corrupted = `${oversized.serialized} `;
    const result = await retrieveVerifiedMemories({
      heads: [oversized.head], scope: { campaignId, characterId }, query: 'x', destroy: vi.fn(),
      recall: async () => ({ results: [{ blob_id: oversized.blobId, text: corrupted }] }),
    });
    expect(result).toMatchObject({ status: 'unavailable', facts: [], selectedMemoryIds: [] });
  });

  it('bounds candidates, selected facts, and total context characters while prioritizing durable mutable facts', async () => {
    const heads = Array.from({ length: 20 }, (_, index) => fixture(index + 20, { kind: index < 2 ? 'episode' : 'promise', text: 'x'.repeat(350) }));
    const recall = vi.fn(async (namespace: string) => {
      const found = heads.find((item) => item.head.namespace === namespace)!;
      return { results: [found.result] };
    });
    const result = await retrieveVerifiedMemories({ heads: heads.map((item) => item.head), scope: { campaignId, characterId }, query: 'x', recall, destroy: vi.fn() });
    expect(recall).toHaveBeenCalledTimes(16);
    expect(result.retrievedBlobIds).toHaveLength(16);
    expect(result).toMatchObject({ candidateCount: 16, omittedCandidateCount: 4 });
    expect(result.selectedMemoryIds).toHaveLength(9);
    expect(result.selectedMemoryIds.slice(0, 9)).not.toContain(heads[0]!.head.memoryId);
    expect(result.facts.join('\n').length).toBeLessThanOrEqual(4000);
  });

  it('ranks verified memories by provider distance within mutable and episode groups', async () => {
    const farPromise = fixture(60, { kind: 'promise' });
    const nearReason = fixture(61, { kind: 'reason' });
    const nearEpisode = fixture(62, { kind: 'episode' });
    const distances = new Map([[farPromise.head.namespace, 0.8], [nearReason.head.namespace, 0.1], [nearEpisode.head.namespace, 0.01]]);
    const fixtures = [farPromise, nearReason, nearEpisode];
    const result = await retrieveVerifiedMemories({
      heads: fixtures.map((item) => { const { kind: _kind, ...head } = item.head; return head; }), scope: { campaignId, characterId }, query: 'x', destroy: vi.fn(),
      recall: async (namespace) => { const item = fixtures.find((value) => value.head.namespace === namespace)!; return { results: [{ ...item.result, distance: distances.get(namespace) }] }; },
    });
    expect(result.selectedMemoryIds).toEqual([nearReason.head.memoryId, farPromise.head.memoryId, nearEpisode.head.memoryId]);
  });

  it('uses envelope kind for selection and treats mutable metadata as a retrieval hint only', async () => {
    const metadataHintEpisode = fixture(63, { kind: 'episode' });
    const actualPromise = fixture(64, { kind: 'promise' });
    const heads: RecallHead[] = [
      { ...metadataHintEpisode.head, kind: undefined, mutable: true },
      { ...actualPromise.head, kind: undefined, mutable: false },
    ];
    const recallOrder: string[] = [];
    const fixtures = [metadataHintEpisode, actualPromise];
    const result = await retrieveVerifiedMemories({
      heads, scope: { campaignId, characterId }, query: 'x', destroy: vi.fn(),
      recall: async (namespace) => { recallOrder.push(namespace); const item = fixtures.find((value) => value.head.namespace === namespace)!; return { results: [item.result] }; },
    });
    expect(recallOrder).toEqual([metadataHintEpisode.head.namespace, actualPromise.head.namespace]);
    expect(result.selectedMemoryIds).toEqual([actualPromise.head.memoryId, metadataHintEpisode.head.memoryId]);
  });

  it('counts the joining newline against the total context character budget', async () => {
    const one = fixture(65, { kind: 'promise' });
    const two = fixture(66, { kind: 'promise' });
    const factLength = (item: ReturnType<typeof fixture>) => `The player said (not proof of completed game actions): ${item.envelope.text}`.length;
    const recall = async (namespace: string) => ({ results: [namespace === one.head.namespace ? one.result : two.result] });
    const result = await retrieveVerifiedMemories({
      heads: [one.head, two.head], scope: { campaignId, characterId }, query: 'x', recall, destroy: vi.fn(),
      budget: { characters: factLength(one) + factLength(two) },
    });
    expect(result.selectedMemoryIds).toHaveLength(1);
    expect(result.facts.join('\n').length).toBeLessThanOrEqual(factLength(one) + factLength(two));
  });

  it('enforces per-call and total time budgets and destroys each opened client', async () => {
    const one = fixture(70); const two = fixture(71);
    const destroy = vi.fn();
    const recall = vi.fn(async (namespace: string) => {
      if (namespace === one.head.namespace) return { results: [one.result] };
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { results: [two.result] };
    });
    const result = await retrieveVerifiedMemories({
      heads: [one.head, two.head], scope: { campaignId, characterId }, query: 'x', recall, destroy,
      budget: { perCallMs: 10, totalMs: 20 },
    });
    expect(result).toMatchObject({ status: 'unavailable', facts: [], selectedMemoryIds: [] });
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});

