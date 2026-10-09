import type { RestoreResult } from '@mysten-incubation/memwal';
import { opaqueNamespace } from './scope';

export type MaintenanceScope = { userId: string; campaignId: string; characterId: 'mira' };
export type InventoryRow = {
  memory_id: string; user_id: string; campaign_id: string; character_id: string;
  namespace: string; revision: number; fact_key_hash: string | null; status: string;
  blob_id: string | null; receipt_blob_id: string | null; checksum: string | null;
  active_memory_id: string | null; pending_revision: number | null; forgotten: boolean;
  memory_kind?: string | null;
};
export type InventoryQuery = (sql: string, values: unknown[]) => Promise<{ rows: InventoryRow[] }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateMaintenanceScope(scope: MaintenanceScope) {
  if (!UUID.test(scope.userId) || !UUID.test(scope.campaignId) || scope.characterId !== 'mira') throw new Error('INVALID_MAINTENANCE_SCOPE');
}
export function boundedLimit(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('INVALID_MAINTENANCE_LIMIT');
  return value;
}

export function validateOwnedRow(row: InventoryRow, scope: MaintenanceScope) {
  validateMaintenanceScope(scope);
  if (row.user_id !== scope.userId || row.campaign_id !== scope.campaignId || row.character_id !== scope.characterId || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('MEMORY_MAINTENANCE_SCOPE_MISMATCH');
  if (row.fact_key_hash !== null && !/^[0-9a-f]{64}$/.test(row.fact_key_hash)) throw new Error('INVALID_MAINTENANCE_FACT_HASH');
  const base = opaqueNamespace(scope.userId, scope.campaignId, scope.characterId);
  const expected = row.fact_key_hash && !['episode','summary'].includes(row.memory_kind ?? '') ? `${base}-${row.fact_key_hash.slice(0, 8)}-r${row.revision}` : base;
  if (row.namespace !== expected) throw new Error('MEMORY_MAINTENANCE_NAMESPACE_MISMATCH');
}

export async function loadMaintenanceInventory(query: InventoryQuery, scope: MaintenanceScope, limit = 100) {
  validateMaintenanceScope(scope); boundedLimit(limit, 500);
  // Both campaign owner and outbox owner must match. No owner-wide SDK listing.
  const result = await query(`SELECT o.memory_id,o.user_id,o.campaign_id,o.character_id,o.namespace,o.revision,o.fact_key_hash,o.memory_kind,o.status,o.blob_id,
    r.blob_id AS receipt_blob_id,r.checksum,h.active_memory_id,h.pending_revision,(t.fact_key_hash IS NOT NULL) AS forgotten
    FROM memory_outbox o JOIN campaigns c ON c.id=o.campaign_id AND c.user_id=o.user_id
    LEFT JOIN memory_receipts r ON r.memory_id=o.memory_id
    LEFT JOIN fact_heads h ON h.campaign_id=o.campaign_id AND h.character_id=o.character_id AND h.fact_key_hash=o.fact_key_hash
    LEFT JOIN memory_tombstones t ON t.campaign_id=o.campaign_id AND t.character_id=o.character_id AND t.fact_key_hash=o.fact_key_hash
    WHERE o.user_id=$1 AND o.campaign_id=$2 AND o.character_id=$3 ORDER BY o.created_at,o.memory_id LIMIT $4`,
  [scope.userId, scope.campaignId, scope.characterId, limit + 1]);
  const rows = result.rows.slice(0, limit);
  rows.forEach(row => validateOwnedRow(row, scope));
  return { rows, truncated: result.rows.length > limit };
}

export function retentionInventory(rows: InventoryRow[], scope: MaintenanceScope, truncated = false) {
  rows.forEach(row => validateOwnedRow(row, scope));
  return {
    scope, truncated, completeness: truncated ? 'bounded_subset' : 'database_inventory_only',
    entries: rows.map(row => ({
      memoryId: row.memory_id, namespace: row.namespace, blobId: row.receipt_blob_id, status: row.status,
      disposition: row.forgotten ? 'forgotten' : row.pending_revision !== null ? 'correction_pending' : row.active_memory_id === row.memory_id ? 'active' : row.fact_key_hash ? 'inactive_revision' : 'unversioned',
      envelopeExpiresAt: null, envelopeExpiryStatus: 'unknown_content_not_loaded',
      storageEndEpoch: null, storageExpiryStatus: 'unknown_independent_chain_lookup_required',
    })),
    renewalImplemented: false, remoteDeletionImplemented: false,
  };
}

export async function restoreScopedIndex(input: {
  scope: MaintenanceScope; rows: InventoryRow[]; inventoryTruncated?: boolean; apply?: boolean;
  namespaceLimit?: number; blobLimit?: number;
  createTransport: (namespace: string) => { restore(namespace: string, limit: number): Promise<RestoreResult>; destroy(): void };
}) {
  const namespaceLimit = boundedLimit(input.namespaceLimit ?? 8, 16);
  const blobLimit = boundedLimit(input.blobLimit ?? 10, 50);
  input.rows.forEach(row => validateOwnedRow(row, input.scope));
  // Restore only receipt-backed active, unsuppressed revisions; never revive forgotten facts.
  const namespaces = [...new Set(input.rows.filter(row => !row.forgotten && row.pending_revision === null && row.status === 'confirmed' && row.blob_id && row.blob_id === row.receipt_blob_id && row.checksum && (row.active_memory_id === row.memory_id || row.fact_key_hash === null)).map(row => row.namespace))];
  const selected = namespaces.slice(0, namespaceLimit);
  const outcomes: Array<{ namespace: string; result?: RestoreResult; errorCode?: string }> = [];
  if (input.apply) for (const namespace of selected) {
    let transport: ReturnType<typeof input.createTransport> | undefined;
    try {
      transport = input.createTransport(namespace);
      const result = await transport.restore(namespace, blobLimit);
      if (result.namespace !== namespace) throw new Error('RESTORE_RESULT_SCOPE_MISMATCH');
      outcomes.push({ namespace, result });
    } catch { outcomes.push({ namespace, errorCode: 'RESTORE_FAILED' }); }
    finally { try { transport?.destroy(); } catch { /* SDK cleanup does not change restore outcome */ } }
  }
  return {
    mode: input.apply ? 'applied' : 'dry_run', namespaces: selected, blobLimit,
    omittedNamespaceCount: namespaces.length - selected.length,
    inventoryTruncated: Boolean(input.inventoryTruncated), outcomes,
    completeRecoveryProven: false,
    note: 'Restore rebuilds the relayer index. It does not renew storage, delete blobs, restore application receipts, or prove complete recovery; SDK discovery has no pagination cursor.',
  };
}
