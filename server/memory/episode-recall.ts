import { createMemWal, checksum } from './adapter';
import { envelopeSchema } from './extract';
import { factHash, opaqueNamespace } from './scope';
import { validateMaintenanceScope } from './lifecycle';

type EpisodeHead = { memory_id: string; active_revision: number; fact_key_hash: string; blob_id: string; checksum: string };
type EpisodeDb = { query(sql: string, values: unknown[]): Promise<{ rows: EpisodeHead[] }> };
type EpisodeTransport = { recall(input: { namespace: string; query: string; limit: number }): Promise<{ results: Array<{ blob_id: string; text: string }>; dropped_count?: number }>; destroy(): void };
export type EpisodeRecallResult = { facts: string[]; selectedMemoryIds: string[]; selectedBlobIds?:string[]; status: 'recalled' | 'empty' | 'unavailable' };
export async function episodesStillActive(db:EpisodeDb,session:{userId:string;campaignId:string},ids:string[]) {
  if(!ids.length)return true;
  const namespace=opaqueNamespace(session.userId,session.campaignId);
  const rows=await db.query(`${projection}${eligible} AND o.memory_id=ANY($4::uuid[]) LIMIT 3`,[session.userId,session.campaignId,namespace,ids]);
  return ids.length===rows.rows.length&&ids.every(id=>rows.rows.some(row=>row.memory_id===id));
}
const eligible = `FROM fact_heads h JOIN memory_outbox o ON o.memory_id=h.active_memory_id AND o.campaign_id=h.campaign_id AND o.character_id=h.character_id AND o.fact_key_hash=h.fact_key_hash
  JOIN campaigns c ON c.id=o.campaign_id AND c.user_id=o.user_id
  JOIN memory_receipts r ON r.memory_id=o.memory_id AND r.blob_id=o.blob_id AND r.recall_verified_at IS NOT NULL
  WHERE c.user_id=$1 AND o.user_id=$1 AND h.campaign_id=$2 AND h.character_id='mira'
  AND h.pending_revision IS NULL AND o.revision=h.active_revision AND o.status='confirmed' AND o.memory_kind='episode' AND o.namespace=$3
  AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.campaign_id=h.campaign_id AND t.character_id=h.character_id AND t.fact_key_hash=h.fact_key_hash)`;
const projection = 'SELECT o.memory_id,h.active_revision,h.fact_key_hash,r.blob_id,r.checksum ';
const empty = (status: 'empty' | 'unavailable'): EpisodeRecallResult => ({ facts: [], selectedMemoryIds: [], status });

/** Optional engine episodes: content comes only from verified Walrus recall, never SQL events. */
export async function recallEngineEpisodes(input: {
  db: EpisodeDb | null; session: { userId: string; campaignId: string }; query: string;
  createTransport?: (namespace: string) => EpisodeTransport; timeoutMs?: number; now?: number;
}): Promise<EpisodeRecallResult> {
  if (!input.db) return empty('empty');
  let transport: EpisodeTransport | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    validateMaintenanceScope({ ...input.session, characterId: 'mira' });
    const namespace = opaqueNamespace(input.session.userId, input.session.campaignId);
    const values = [input.session.userId, input.session.campaignId, namespace];
    const heads = await input.db.query(`${projection}${eligible} ORDER BY o.created_at DESC,o.memory_id LIMIT 20`, values);
    if (!heads.rows.length) return empty('empty');
    transport = (input.createTransport ?? createMemWal)(namespace);
    const recalled = await Promise.race([
      transport.recall({ namespace, query: input.query.slice(0, 2000), limit: 20 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('EPISODE_RECALL_TIMEOUT')), Math.max(1, Math.min(3000, input.timeoutMs ?? 3000))); }),
    ]);
    if (recalled.dropped_count || !Array.isArray(recalled.results)) return empty('unavailable');
    const selected: Array<{ head: EpisodeHead; fact: string }> = []; let characters = 0;
    for (const item of recalled.results.slice(0, 20)) {
      const head = heads.rows.find(row => row.blob_id === item.blob_id);
      if (!head || selected.some(row => row.head.memory_id === head.memory_id)) continue;
      if (checksum(item.text) !== head.checksum) return empty('unavailable');
      const parsed = envelopeSchema.safeParse(JSON.parse(item.text));
      if (!parsed.success) return empty('unavailable');
      const envelope = parsed.data;
      if (envelope.memoryId !== head.memory_id || envelope.campaignId !== input.session.campaignId || envelope.characterId !== 'mira' || envelope.kind !== 'episode' || envelope.source.type !== 'game' || envelope.revision !== head.active_revision || !envelope.factKey || factHash(envelope.factKey) !== head.fact_key_hash) continue;
      if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= (input.now ?? Date.now())) continue;
      const fact = `Engine-confirmed recalled event: ${envelope.text}`;
      if (selected.length >= 3 || characters + fact.length + (selected.length ? 1 : 0) > 1500) continue;
      characters += fact.length + (selected.length ? 1 : 0); selected.push({ head, fact });
    }
    if (!selected.length) return empty('empty');
    const recheck = await input.db.query(`${projection}${eligible} AND o.memory_id=ANY($4::uuid[]) LIMIT 3`, [...values, selected.map(row => row.head.memory_id)]);
    if (recheck.rows.length !== selected.length || selected.some(({ head }) => !recheck.rows.some(row => row.memory_id === head.memory_id && row.active_revision === head.active_revision && row.fact_key_hash === head.fact_key_hash && row.blob_id === head.blob_id && row.checksum === head.checksum))) return empty('unavailable');
    return { facts: selected.map(row => row.fact), selectedMemoryIds: selected.map(row => row.head.memory_id),selectedBlobIds:selected.map(row=>row.head.blob_id), status: 'recalled' };
  } catch { return empty('unavailable'); }
  finally { if (timer) clearTimeout(timer); try { transport?.destroy(); } catch { /* optional cleanup */ } }
}
