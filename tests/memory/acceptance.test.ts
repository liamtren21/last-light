import { describe, expect, it } from 'vitest';
import { validateCandidateProposal } from '../../server/memory/extract';
import { findReconciledMemory } from '../../server/memory/worker';

const campaignA = '00000000-0000-4000-8000-000000000001';
const campaignB = '00000000-0000-4000-8000-000000000002';
const eventId = '00000000-0000-4000-8000-000000000003';

describe('memory acceptance boundaries', () => {
  it('rejects a new overlong proposal rather than storing a fact that cannot fit recall context', () => {
    const message='I prefer quiet.';
    const proposal={kind:'preference',factKey:'preference.quiet',text:'x'.repeat(501),sourceQuote:message};
    expect(validateCandidateProposal({proposal,message,campaignId:campaignA,eventId})).toBeNull();
  });
  it('scopes deterministic memory IDs to the campaign', () => {
    const proposal = {
      kind: 'preference', factKey: 'preference.quiet', text: 'The player prefers quiet.',
      sourceQuote: 'I prefer quiet.', expiresInSeconds: null,
    };
    const first = validateCandidateProposal({ proposal, message: 'I prefer quiet.', campaignId: campaignA, eventId });
    const second = validateCandidateProposal({ proposal, message: 'I prefer quiet.', campaignId: campaignB, eventId });

    expect(first?.memoryId).toBeDefined();
    expect(second?.memoryId).toBeDefined();
    expect(first?.memoryId).not.toBe(second?.memoryId);
  });

  it('assigns keyless episodes a deterministic logical key while retaining user provenance', () => {
    const proposal = {
      kind: 'episode', text: 'The player said the ferry was late.',
      sourceQuote: 'The ferry was late.', expiresInSeconds: null,
    };
    const input = { proposal, message: 'The ferry was late.', campaignId: campaignA, eventId };
    const first = validateCandidateProposal(input);
    const replay = validateCandidateProposal(input);

    expect(first?.factKey).toBe(`episode.${first?.memoryId}`);
    expect(replay?.memoryId).toBe(first?.memoryId);
    expect(first?.source.type).toBe('user');
    expect(first?.kind).toBe('episode');
  });

  it('reconciles only an exact stored envelope match', () => {
    const payload = JSON.stringify({ memoryId: 'stable-id', text: 'The player prefers quiet.' });
    expect(findReconciledMemory(payload, [{ blob_id: 'blob-1', text: payload }])).toEqual({ blobId: 'blob-1' });
    expect(findReconciledMemory(payload, [{ blob_id: 'blob-2', text: 'The player prefers quiet.' }])).toBeNull();
    expect(findReconciledMemory(payload, [])).toBeNull();
  });
});
