import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ remember: vi.fn(), waitForRememberJob: vi.fn(), recall: vi.fn(), destroy: vi.fn(), create: vi.fn() }));
vi.mock('@mysten-incubation/memwal', () => ({ MemWal: { create: sdk.create } }));
vi.mock('../../server/config', () => ({ config: { memwalAccountId: 'fixture', memwalDelegateKey: 'fixture', memwalRelayerUrl: 'https://fixture.invalid' } }));
import { verifiedRoundTrip, checksum } from '../../server/memory/adapter';
import { extractCandidate } from '../../server/memory/extract';
const envelope = extractCandidate({ message: 'Call me An.', campaignId: '00000000-0000-4000-8000-000000000001', eventId: '00000000-0000-4000-8000-000000000002' })!;
const text = JSON.stringify(envelope);
describe('MemWal protocol adapter with mocked SDK receipts', () => {
  beforeEach(() => {
    vi.resetAllMocks(); sdk.create.mockReturnValue(sdk);
    sdk.remember.mockResolvedValue({ job_id: 'job' }); sdk.waitForRememberJob.mockResolvedValue({ blob_id: 'blob' });
    sdk.recall.mockResolvedValue({ results: [{ blob_id: 'blob', text }] });
  });
  it('requires a completed receipt and exact blob/payload recall and sends a stable idempotency key', async () => {
    expect(await verifiedRoundTrip(envelope, 'isolated-fixture')).toEqual({ jobId: 'job', blobId: 'blob', checksum: checksum(text), recalled: true });
    expect(sdk.remember).toHaveBeenCalledWith(text, 'isolated-fixture', { idempotencyKey: envelope.memoryId });
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    ['wrong blob', [{ blob_id: 'other', text }]],
    ['changed text', [{ blob_id: 'blob', text: text + ' ' }]],
    ['empty recall', []],
  ])('refuses %s as a verified write', async (_, results) => {
    sdk.recall.mockResolvedValue({ results });
    await expect(verifiedRoundTrip(envelope, 'isolated-fixture')).rejects.toThrow('MEMORY_ROUND_TRIP_NOT_VERIFIED');
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
  it('does not treat acceptance as confirmation when the job has no blob receipt', async () => {
    sdk.waitForRememberJob.mockResolvedValue({ status: 'pending' });
    await expect(verifiedRoundTrip(envelope, 'isolated-fixture')).rejects.toThrow('MEMORY_JOB_WITHOUT_BLOB_RECEIPT');
    expect(sdk.recall).not.toHaveBeenCalled();
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
});
