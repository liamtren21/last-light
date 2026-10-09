import { checksum } from './adapter';
import { envelopeSchema } from './extract';
import type { MemoryEnvelope } from './extract';
import { factHash } from './scope';
import {retryTransientRead} from './read-retry';

export type RecallHead = {
  factKeyHash: string;
  activeRevision: number;
  memoryId: string;
  namespace: string;
  blobId: string;
  checksum: string;
  campaignId: string;
  characterId: string;
  kind?: 'preference' | 'promise' | 'reason' | 'episode' | 'summary';
  mutable?: boolean;
  createdAt?: string | number;
};

export type RecallItem = { blob_id: string; text: string; distance?: number };
export type RecallClientResult = { results: RecallItem[] };
export type RetrievalResult = {
  facts: string[];
  coordination?: {technique:'pair-check'|'call-response';cue:string};
  status: 'recalled' | 'empty' | 'unavailable';
  retrievedMemoryIds: string[];
  retrievedBlobIds: string[];
  selectedMemoryIds: string[];
  selectedBlobIds: string[];
  calls: number;
  durationMs: number;
  candidateCount: number;
  omittedCandidateCount: number;
};

const HARD_BUDGET = { candidates: 16, selected: 12, characters: 4000, perEnvelopeCharacters: 500, perCallMs: 10_000, totalMs: 12_000 } as const;
const mutablePriority = new Set(['preference', 'promise', 'reason']);

export function formatVerifiedMemoryFact(envelope:Pick<MemoryEnvelope,'source'|'text'>){
  return `${envelope.source.type==='game'?'Engine-confirmed event':'The player said (not proof of completed game actions)'}: ${envelope.text}`;
}

function priority(kind?: RecallHead['kind'], mutable = false) { return mutable || Boolean(kind && mutablePriority.has(kind)) ? 0 : 1; }

function createdTime(head: RecallHead) {
  const parsed = typeof head.createdAt === 'number' ? head.createdAt : head.createdAt ? Date.parse(head.createdAt) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function fail(result: Pick<RetrievalResult, 'retrievedMemoryIds' | 'retrievedBlobIds' | 'calls' | 'durationMs' | 'candidateCount' | 'omittedCandidateCount'>): RetrievalResult {
  return { ...result, facts: [], status: 'unavailable', selectedMemoryIds: [], selectedBlobIds: [] };
}

export async function retrieveVerifiedMemories(input: {
  heads: RecallHead[];
  scope: { campaignId: string; characterId: string };
  query: string;
  recall: (namespace: string, query: string, limit: number) => Promise<RecallClientResult>;
  destroy: (namespace: string) => void;
  budget?: Partial<{ candidates: number; selected: number; characters: number; perEnvelopeCharacters: number; perCallMs: number; totalMs: number }>;
  now?: number;
}): Promise<RetrievalResult> {
  const startedAt = Date.now();
  const budget = {
    candidates: Math.max(0, Math.min(HARD_BUDGET.candidates, input.budget?.candidates ?? HARD_BUDGET.candidates)),
    selected: Math.max(0, Math.min(HARD_BUDGET.selected, input.budget?.selected ?? HARD_BUDGET.selected)),
    characters: Math.max(0, Math.min(HARD_BUDGET.characters, input.budget?.characters ?? HARD_BUDGET.characters)),
    perEnvelopeCharacters: Math.max(0, Math.min(HARD_BUDGET.perEnvelopeCharacters, input.budget?.perEnvelopeCharacters ?? HARD_BUDGET.perEnvelopeCharacters)),
    perCallMs: Math.max(1, Math.min(HARD_BUDGET.perCallMs, input.budget?.perCallMs ?? HARD_BUDGET.perCallMs)),
    totalMs: Math.max(1, Math.min(HARD_BUDGET.totalMs, input.budget?.totalMs ?? HARD_BUDGET.totalMs)),
  };
  const retrievedMemoryIds: string[] = [];
  const retrievedBlobIds: string[] = [];
  let calls = 0;
  const elapsed = () => Date.now() - startedAt;
  const allHeads = input.heads.slice().sort((a, b) => priority(a.kind, a.mutable) - priority(b.kind, b.mutable) || createdTime(b) - createdTime(a));
  const heads = allHeads.slice(0, budget.candidates);
  const instrumentation = () => ({ retrievedMemoryIds, retrievedBlobIds, calls, durationMs: elapsed(), candidateCount: heads.length, omittedCandidateCount: allHeads.length - heads.length });
  const verified: Array<{ head: RecallHead; kind: NonNullable<RecallHead['kind']>; text: string; fact: string; distance: number; envelope:MemoryEnvelope }> = [];

  // A single bad scope invalidates the entire request before remote I/O.
  if(heads.some(head=>head.campaignId!==input.scope.campaignId||head.characterId!==input.scope.characterId))return fail(instrumentation());
  const namespaces=[...new Set(heads.map(head=>head.namespace))];
  const recalledByNamespace=new Map<string,RecallClientResult>();
  let cursor=0;let unavailable=false;
  await Promise.all(Array.from({length:Math.min(4,namespaces.length)},async()=>{
    while(cursor<namespaces.length&&!unavailable){
      const namespace=namespaces[cursor++]!;
      if(elapsed()>=budget.totalMs){unavailable=true;break;}
      let timer:ReturnType<typeof setTimeout>|undefined;let active=true;
      try{
        const timeoutMs=Math.max(1,Math.min(budget.perCallMs,budget.totalMs-elapsed()));
        const recalled=await Promise.race([
          retryTransientRead(()=>{calls++;return input.recall(namespace,input.query.slice(0,2000),Math.max(10,heads.filter(h=>h.namespace===namespace).length));},()=>active&&elapsed()<budget.totalMs),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEMORY_RECALL_TIMEOUT')),timeoutMs);}),
        ]);
        if(!recalled||!Array.isArray(recalled.results))throw new Error('MEMORY_INVALID_RESPONSE');
        recalledByNamespace.set(namespace,recalled);
      }catch{unavailable=true;}
      finally{active=false;if(timer)clearTimeout(timer);try{input.destroy(namespace);}catch{/* client cleanup */}}
    }
  }));
  if(unavailable||elapsed()>budget.totalMs)return fail(instrumentation());
  for(const head of heads){
    try{
      const item=recalledByNamespace.get(head.namespace)?.results.find(candidate=>candidate.blob_id===head.blobId);
      if(!item)return fail(instrumentation());
      retrievedMemoryIds.push(head.memoryId);retrievedBlobIds.push(item.blob_id);
      if(checksum(item.text)!==head.checksum)return fail(instrumentation());
      const parsed=envelopeSchema.safeParse(JSON.parse(item.text));
      if(!parsed.success)return fail(instrumentation());
      const envelope=parsed.data;
      if(envelope.memoryId!==head.memoryId||envelope.campaignId!==input.scope.campaignId||envelope.characterId!==input.scope.characterId||envelope.campaignId!==head.campaignId||envelope.characterId!==head.characterId||envelope.revision!==head.activeRevision||!envelope.factKey||factHash(envelope.factKey)!==head.factKeyHash||envelope.kind!==head.kind&&head.kind!==undefined)return fail(instrumentation());
      if(envelope.text.length>budget.perEnvelopeCharacters)continue;
      if(envelope.expiresAt){const expiresAt=Date.parse(envelope.expiresAt);if(!Number.isFinite(expiresAt))return fail(instrumentation());if(expiresAt<=(input.now??Date.now()))continue;}
      verified.push({head,kind:envelope.kind,text:envelope.text,fact:formatVerifiedMemoryFact(envelope),distance:Number.isFinite(item.distance)?item.distance!:Number.POSITIVE_INFINITY,envelope});
    }catch{return fail(instrumentation());}
  }

  verified.sort((a, b) => priority(a.kind) - priority(b.kind) || a.distance - b.distance);
  const selected: typeof verified = [];
  let characters = 0;
  for (const item of verified) {
    if (selected.length >= budget.selected) break;
    const separatorCharacters = selected.length > 0 ? 1 : 0;
    if (characters + separatorCharacters + item.fact.length > budget.characters) continue;
    selected.push(item);
    characters += separatorCharacters + item.fact.length;
  }
  const base = instrumentation();
  const plan=selected.find(item=>item.envelope.factKey==='cooperation.plan'&&item.envelope.source.type==='user')?.envelope.cooperation;
  return {
    ...base,
    ...(plan?.technique&&plan.cue?{coordination:{technique:plan.technique,cue:plan.cue}}:{}),
    facts: selected.map((item) => item.fact),
    status: selected.length ? 'recalled' : 'empty',
    selectedMemoryIds: selected.map((item) => item.head.memoryId),
    selectedBlobIds: selected.map((item) => item.head.blobId),
  };
}
