import { pool, migrate } from '../db';
import { createMemWal } from './adapter';
import { decryptPayload } from './crypto';
import { checksum } from './adapter';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { classifyWorkerFailure, shouldActivateRevision } from './resolve';
import { envelopeSchema } from './extract';

export function findReconciledMemory(expectedPayload: string, results: Array<{ blob_id: string; text: string }>) {
  const match = results.find((item) => item.text === expectedPayload);
  return match ? { blobId: match.blob_id } : null;
}

export async function processMemoryJob(createTransport: typeof createMemWal = createMemWal) {
  if (!pool) return false;
  const claim = await pool.query(`UPDATE memory_outbox SET lease_until=now()+interval '2 minutes', attempts=attempts+1, updated_at=now() WHERE memory_id=(SELECT memory_id FROM memory_outbox WHERE status IN ('queued','accepted','pending_unknown') AND (error_code IS NULL OR error_code NOT IN ('RECONCILIATION_REQUIRED','RECONCILED_BLOB_NO_JOB_ID')) AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  const row = claim.rows[0]; if (!row) return false;
  let memwal: ReturnType<typeof createMemWal> | undefined;
  let acceptedJobId: string | undefined = row.job_id ?? undefined;
  try {
    const payload = decryptPayload(row.payload_ciphertext);
    const envelope = envelopeSchema.safeParse(JSON.parse(payload));
    const parsed = JSON.parse(payload) as { memoryId: string; factKey?: string; revision: number; campaignId: string; characterId: string };
    if (row.fact_key_hash) {
      const forgotten = await pool.query("SELECT 1 FROM memory_tombstones WHERE campaign_id=$1 AND character_id=$2 AND fact_key_hash=$3", [row.campaign_id,row.character_id,row.fact_key_hash]);
      if (forgotten.rowCount) {
        await pool.query("UPDATE memory_outbox SET status='failed',payload_ciphertext='',lease_until=NULL,error_code='MEMORY_FORGOTTEN',next_attempt_at='infinity',updated_at=now() WHERE memory_id=$1", [row.memory_id]);
        return true;
      }
    }
    memwal = createTransport(row.namespace);
    if (row.status === 'pending_unknown' && !acceptedJobId) {
      let reconciled = null;
      try {
        const recalled = await memwal.recall({ namespace: row.namespace, query: parsed.memoryId, limit: 20 });
        reconciled = findReconciledMemory(payload, recalled.results);
      } catch { /* unavailable recall cannot prove that the prior write did not land */ }
      const errorCode = reconciled ? 'RECONCILED_BLOB_NO_JOB_ID' : 'RECONCILIATION_REQUIRED';
      await pool.query("UPDATE memory_outbox SET status='pending_unknown',error_code=$2,lease_until=NULL,next_attempt_at='infinity',updated_at=now() WHERE memory_id=$1", [row.memory_id, errorCode]);
      return true;
    }
    if (!acceptedJobId) {
      // Persist uncertain acceptance before crossing the network boundary. A crash cannot leave a queued write.
      await pool.query("UPDATE memory_outbox SET status='pending_unknown',updated_at=now() WHERE memory_id=$1",[row.memory_id]);
      const accepted = await memwal.remember(payload, row.namespace, { idempotencyKey: parsed.memoryId });
      acceptedJobId = accepted.job_id;
      await pool.query("UPDATE memory_outbox SET status='accepted',job_id=$2,updated_at=now() WHERE memory_id=$1", [row.memory_id, acceptedJobId]);
    }
    const receipt = await memwal.waitForRememberJob(acceptedJobId!, { timeoutMs: 60_000 });
    if (!receipt.blob_id) throw new Error('MISSING_BLOB_RECEIPT');
    const result = await memwal.recall({ namespace: row.namespace, query: parsed.factKey ?? payload, limit: 10 });
    const recalled = result.results.find((item) => item.blob_id === receipt.blob_id && item.text === payload);
    if (!recalled) throw new Error('ROUND_TRIP_NOT_VERIFIED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE', [row.campaign_id]);
      await client.query("INSERT INTO memory_receipts(memory_id,job_id,blob_id,checksum,recall_verified_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(memory_id) DO UPDATE SET job_id=excluded.job_id,blob_id=excluded.blob_id,checksum=excluded.checksum,recall_verified_at=now()", [row.memory_id, acceptedJobId, receipt.blob_id, checksum(payload)]);
      await client.query("UPDATE memory_outbox SET status='confirmed',blob_id=$2,payload_ciphertext='',lease_until=NULL,error_code=NULL,memory_kind=COALESCE($3,memory_kind),updated_at=now() WHERE memory_id=$1", [row.memory_id, receipt.blob_id,envelope.success?envelope.data.kind:null]);
      if (row.fact_key_hash) {
        // Match forget's campaign-first lock order so its tombstone cannot race activation.
        const forgotten = await client.query('SELECT 1 FROM memory_tombstones WHERE campaign_id=$1 AND character_id=$2 AND fact_key_hash=$3', [row.campaign_id,row.character_id,row.fact_key_hash]);
        if (!forgotten.rowCount) {
          const head = await client.query('SELECT active_revision,pending_revision FROM fact_heads WHERE campaign_id=$1 AND character_id=$2 AND fact_key_hash=$3 FOR UPDATE', [row.campaign_id,row.character_id,row.fact_key_hash]);
          const current = head.rows[0];
          if (current && shouldActivateRevision(current.active_revision, current.pending_revision, row.revision)) await client.query("UPDATE fact_heads SET active_revision=$4,active_memory_id=$5,pending_revision=CASE WHEN pending_revision=$4 THEN NULL ELSE pending_revision END,updated_at=now() WHERE campaign_id=$1 AND character_id=$2 AND fact_key_hash=$3", [row.campaign_id,row.character_id,row.fact_key_hash,row.revision,row.memory_id]);
          if (!current && row.revision === 1) await client.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,active_memory_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(campaign_id,character_id,fact_key_hash) DO NOTHING", [row.campaign_id,row.character_id,row.fact_key_hash,row.revision,row.memory_id]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch (error) {
    const failure = classifyWorkerFailure(error, row.attempts, Boolean(acceptedJobId));
    await pool.query("UPDATE memory_outbox SET status=$2,error_code=$3,lease_until=NULL,next_attempt_at=now()+make_interval(secs=>$4),job_id=COALESCE(job_id,$5),updated_at=now() WHERE memory_id=$1", [row.memory_id, failure.status, failure.errorCode, failure.nextAttemptSeconds,acceptedJobId??null]);
  } finally { memwal?.destroy(); }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!pool) { console.error('Memory worker unavailable: DATABASE_URL is required.'); process.exitCode = 1; }
  else {
    await migrate();
    console.log('LAST LIGHT memory worker running.');
    let running = true;
    process.on('SIGINT', () => { running = false; }); process.on('SIGTERM', () => { running = false; });
    while (running) { const worked = await processMemoryJob(); if (!worked) await new Promise((resolve) => setTimeout(resolve, 1500)); }
    await pool.end();
  }
}
