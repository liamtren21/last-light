import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMaintenanceInventory, retentionInventory, restoreScopedIndex } from '../../server/memory/lifecycle';
import type { InventoryRow } from '../../server/memory/lifecycle';
import { factHash, opaqueNamespace } from '../../server/memory/scope';
import { parseMaintenanceArgs } from '../../scripts/memory-maintenance';

const scope = { userId: '00000000-0000-4000-8000-000000000001', campaignId: '00000000-0000-4000-8000-000000000002', characterId: 'mira' as const };
function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return { memory_id: 'memory-1', user_id: scope.userId, campaign_id: scope.campaignId, character_id: 'mira', namespace: opaqueNamespace(scope.userId, scope.campaignId, 'mira', 'identity.name', 1), revision: 1, fact_key_hash: factHash('identity.name'), status: 'confirmed', blob_id: 'blob-1', receipt_blob_id: 'blob-1', checksum: 'hash', active_memory_id: 'memory-1', pending_revision: null, forgotten: false, ...overrides };
}
describe('scoped memory maintenance', () => {
  beforeEach(() => { process.env.SESSION_SECRET = 'maintenance-test-secret-more-than-32-characters'; });
  it('dry-run plans restore without constructing a network client', async () => {
    const createTransport = vi.fn();
    const report = await restoreScopedIndex({ scope, rows: [row()], createTransport });
    expect(report.mode).toBe('dry_run'); expect(report.namespaces).toHaveLength(1); expect(createTransport).not.toHaveBeenCalled();
  });
  it('rejects foreign owner, campaign and arbitrary namespace before a network request', async () => {
    const createTransport = vi.fn();
    for (const overrides of [{ user_id: 'other' }, { campaign_id: 'other' }, { namespace: 'client-supplied' }, { fact_key_hash: 'abc' }]) {
      await expect(restoreScopedIndex({ scope, rows: [row(overrides)], apply: true, createTransport })).rejects.toThrow();
    }
    expect(createTransport).not.toHaveBeenCalled();
  });
  it('excludes forgotten, pending corrections, inactive and unreceipted entries', async () => {
    const report = await restoreScopedIndex({ scope, rows: [row({ forgotten: true }), row({ pending_revision: 2 }), row({ active_memory_id: 'new' }), row({ receipt_blob_id: null })], createTransport: vi.fn() });
    expect(report.namespaces).toEqual([]);
  });
  it('applies bounded exact namespace restore and destroys the SDK client', async () => {
    const restore = vi.fn(async (namespace: string) => ({ namespace, owner: 'owner', total: 2, restored: 1, skipped: 0, failed: 0, truncated: true }));
    const destroy = vi.fn();
    const report = await restoreScopedIndex({ scope, rows: [row()], apply: true, blobLimit: 3, createTransport: () => ({ restore, destroy }) });
    expect(restore).toHaveBeenCalledWith(row().namespace, 3); expect(destroy).toHaveBeenCalledOnce();
    expect(report.outcomes[0].result?.truncated).toBe(true); expect(report.completeRecoveryProven).toBe(false);
  });
  it('reports errors safely and cleans clients on rejection', async () => {
    const destroy = vi.fn();
    const report = await restoreScopedIndex({ scope, rows: [row()], apply: true, createTransport: () => ({ restore: async () => { throw new Error('secret content'); }, destroy }) });
    expect(report.outcomes).toEqual([{ namespace: row().namespace, errorCode: 'RESTORE_FAILED' }]); expect(destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain('secret content');
  });
  it('rejects a restore response naming another namespace', async () => {
    const report = await restoreScopedIndex({ scope, rows: [row()], apply: true, createTransport: () => ({ restore: async () => ({ namespace: 'foreign', owner: 'owner', total: 1, restored: 1, skipped: 0, failed: 0, truncated: false }), destroy: vi.fn() }) });
    expect(report.outcomes[0]).toMatchObject({ errorCode: 'RESTORE_FAILED' });
    expect(report.outcomes[0].result).toBeUndefined();
  });
  it('caps namespaces and deduplicates repeated rows without automatic retries', async () => {
    const second = row({ memory_id: 'memory-2', active_memory_id: 'memory-2', fact_key_hash: factHash('promise.meeting'), namespace: opaqueNamespace(scope.userId, scope.campaignId, 'mira', 'promise.meeting', 1) });
    const restore = vi.fn(async (namespace: string) => ({ namespace, owner: 'owner', total: 100, restored: 1, skipped: 0, failed: 0, truncated: true }));
    const report = await restoreScopedIndex({ scope, rows: [row(), row(), second], apply: true, namespaceLimit: 1, createTransport: () => ({ restore, destroy: vi.fn() }) });
    expect(report.omittedNamespaceCount).toBe(1); expect(restore).toHaveBeenCalledOnce();
  });
  it('bounds database scan and only passes server-owned scope parameters', async () => {
    const query = vi.fn(async () => ({ rows: [row(), row()] }));
    const inventory = await loadMaintenanceInventory(query, scope, 1);
    expect(query.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('c.user_id=o.user_id'), [scope.userId, scope.campaignId, 'mira', 2]]));
    expect(inventory.truncated).toBe(true); expect(inventory.rows).toHaveLength(1);
  });
  it('reports unknown envelope expiry separately from unknown chain expiry', () => {
    const report = retentionInventory([row({ forgotten: true })], scope);
    expect(report.entries[0]).toMatchObject({ disposition: 'forgotten', envelopeExpiresAt: null, storageEndEpoch: null });
    expect(report.renewalImplemented).toBe(false); expect(report.remoteDeletionImplemented).toBe(false);
  });
  it('requires UUID ownership scope and explicit apply; rejects unbounded options', () => {
    const args = ['--operation', 'restore-index', '--user', scope.userId, '--campaign', scope.campaignId];
    expect(parseMaintenanceArgs(args).apply).toBe(false); expect(parseMaintenanceArgs([...args, '--apply']).apply).toBe(true);
    for (const extra of [['--blobs', '51'], ['--rows', 'NaN'], ['--namespaces', '0'], ['--namespace', 'arbitrary']]) expect(() => parseMaintenanceArgs([...args, ...extra])).toThrow();
    expect(() => parseMaintenanceArgs(['--user', scope.userId])).toThrow();
  });
});
