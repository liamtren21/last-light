import { createHash } from 'node:crypto';
import { MemWal } from '@mysten-incubation/memwal';
import { config } from '../config';
import type { MemoryEnvelope } from './extract';

export function createMemWal(namespace: string) {
  if (!config.memwalAccountId || !config.memwalDelegateKey || !config.memwalRelayerUrl) throw new Error('MEMWAL_MAINNET_CREDENTIALS_REQUIRED');
  return MemWal.create({ key: config.memwalDelegateKey, accountId: config.memwalAccountId, serverUrl: config.memwalRelayerUrl, namespace });
}
export function serializeEnvelope(envelope: MemoryEnvelope) { return JSON.stringify(envelope); }
export function checksum(text: string) { return createHash('sha256').update(text).digest('hex'); }
export async function verifiedRoundTrip(envelope: MemoryEnvelope, namespace: string) {
  const memwal = createMemWal(namespace);
  try {
    const payload = serializeEnvelope(envelope);
    const accepted = await memwal.remember(payload, namespace, { idempotencyKey: envelope.memoryId });
    const jobId = accepted.job_id;
    const receipt = await memwal.waitForRememberJob(jobId, { timeoutMs: 90_000 });
    if (!receipt.blob_id) throw new Error('MEMORY_JOB_WITHOUT_BLOB_RECEIPT');
    const recalled = await memwal.recall({ namespace, query: envelope.factKey ? `${envelope.factKey} ${envelope.text}` : envelope.text, limit: 10 });
    const match = recalled.results.find((item) => item.blob_id === receipt.blob_id && item.text === payload);
    if (!match) throw new Error('MEMORY_ROUND_TRIP_NOT_VERIFIED');
    return { jobId, blobId: receipt.blob_id, checksum: checksum(payload), recalled: true };
  } finally { memwal.destroy(); }
}
