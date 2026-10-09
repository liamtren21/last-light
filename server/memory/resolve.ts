export type ActiveMemoryRevision = { factKeyHash: string; revision: number; memoryId: string; campaignId: string; characterId: string; recalledBlobId?: string; expectedBlobId?: string; actualChecksum?: string; expectedChecksum?: string; text?: string; expiresAt?: string; pendingRevision?: number | null; tombstoned?: boolean };

export function shouldActivateRevision(activeRevision: number, pendingRevision: number | null, incomingRevision: number) {
  return incomingRevision > activeRevision && (pendingRevision === null || pendingRevision === incomingRevision);
}

export function isFactSuppressed(input: { pendingRevision: number | null; tombstoned: boolean; latestCorrectionStatus?: 'queued' | 'accepted' | 'pending_unknown' | 'confirmed' | 'failed' }) {
  return input.tombstoned || input.pendingRevision !== null;
}

export function isRecallEligible(memory: ActiveMemoryRevision, scope: { campaignId: string; characterId: string }, now = Date.now()) {
  if (memory.campaignId !== scope.campaignId || memory.characterId !== scope.characterId) return false;
  if (!memory.recalledBlobId || memory.recalledBlobId !== memory.expectedBlobId || !memory.text) return false;
  if (memory.actualChecksum !== undefined && memory.expectedChecksum !== undefined && memory.actualChecksum !== memory.expectedChecksum) return false;
  if (memory.pendingRevision !== undefined && isFactSuppressed({ pendingRevision: memory.pendingRevision, tombstoned: memory.tombstoned ?? false })) return false;
  if (memory.tombstoned) return false;
  if (memory.expiresAt) {
    const expiry = new Date(memory.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= now) return false;
  }
  return true;
}

export function classifyWorkerFailure(error: unknown, attempts: number, hasJobId: boolean) {
  const errorCode = error instanceof Error ? error.message.slice(0, 100) : 'MEMORY_WORKER_ERROR';
  const terminal = /401|403|INVALID|AUTH|(?:status|remember job).*failed|not[_ -]?found|MISSING_BLOB/i.test(errorCode) || attempts >= 8;
  return {
    errorCode,
    terminal,
    status: terminal ? 'failed' as const : hasJobId ? 'accepted' as const : 'pending_unknown' as const,
    nextAttemptSeconds: Math.min(3600, 15 * Math.pow(2, Math.min(attempts, 8))),
  };
}

export function canRetryMemory(
  status: string,
  jobId: string | null,
  errorCode: string | null,
  payloadPresent: boolean,
  tombstoned: boolean,
) {
  if (status !== 'failed' || tombstoned || !payloadPresent || errorCode === 'MEMORY_FORGOTTEN') return false;
  if (jobId) return !/(?:status|remember job).*failed|not[_ -]?found|terminal|MISSING_BLOB/i.test(errorCode ?? '');
  return /(?:^|\b)(?:HTTP\s*)?(?:401|403|429)(?:\b|$)|\b(?:AUTH|UNAUTHORIZED|FORBIDDEN|TOO MANY REQUESTS|RATE.?LIMIT)\b/i.test(errorCode ?? '');
}
