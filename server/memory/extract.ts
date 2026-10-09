import { createHash } from 'node:crypto';
import { z } from 'zod';
import {cooperationPlanSchema} from '../../src/game/cooperation';

export const envelopeSchema = z.object({
  schemaVersion: z.literal(1), memoryId: z.string().uuid(), campaignId: z.string().uuid(), characterId: z.literal('mira'),
  kind: z.enum(['preference','promise','reason','episode','summary']), factKey: z.string().optional(), revision: z.number().int().positive(),
  text: z.string().min(1).max(1200), source: z.object({ type: z.enum(['user','game']), id: z.string() }),
  occurredAt: z.string().datetime(), expiresAt: z.string().datetime().optional(), supersedes: z.string().uuid().optional(),
  cooperation:cooperationPlanSchema.optional(),
});
export type MemoryEnvelope = z.infer<typeof envelopeSchema>;

export const candidateProposalSchema = z.object({
  kind: z.enum(['preference','promise','reason','episode','summary']), factKey: z.string().min(1).max(80).optional(),
  text: z.string().min(1).max(500), sourceQuote: z.string().min(1).max(500), expiresInSeconds: z.number().int().positive().max(31_536_000).nullable().optional(),
});
export type CandidateProposal = z.infer<typeof candidateProposalSchema>;
export type MemoryExtractionProvider = { propose(message: string, recalledFacts: string[]): Promise<unknown> };

const unsafeMemoryPatterns = [
  /\b(?:ignore|disregard|bypass|override)\b.{0,80}\b(?:rules?|instructions?|safety|policy|guardrails?)\b/i,
  /\b(?:system prompt|system instruction|developer instruction|admin tool|hidden tool)\b/i,
  /\b(?:reveal|disclose|tell me|show me|output|print)\b.{0,80}\b(?:secret|hidden|future|ending|spoiler|chapter)\b/i,
  /\b(?:must|should|always|obey)\b.{0,80}\b(?:remember|memory|instruction|tool|mira)\b/i,
  /\b(?:act as|pretend to be)\b.{0,80}\b(?:system|administrator|developer|root)\b/i,
  /\b(?:call|invoke|run|execute)\b.{0,80}\b(?:admin|hidden|private|system)\b.{0,30}\b(?:tool|function|command)\b/i,
];

export function isUnsafeMemoryContent(text: string) {
  return unsafeMemoryPatterns.some((pattern) => pattern.test(text));
}

function stableUuid(seed: string) {
  const chars = createHash('sha256').update(seed).digest('hex').slice(0,32).split('');
  chars[12] = '5'; chars[16] = ((parseInt(chars[16]!,16)&3)|8).toString(16);
  return `${chars.slice(0,8).join('')}-${chars.slice(8,12).join('')}-${chars.slice(12,16).join('')}-${chars.slice(16,20).join('')}-${chars.slice(20).join('')}`;
}

export function validateCandidateProposal(input: { proposal: unknown; message: string; campaignId: string; eventId: string; sourceType?: 'user' | 'game' }) {
  const parsed = candidateProposalSchema.safeParse(input.proposal);
  if (!parsed.success) return null;
  const proposal = parsed.data;
  const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
  if (!normalized(input.message).includes(normalized(proposal.sourceQuote))) return null;
  if (isUnsafeMemoryContent(input.message) || isUnsafeMemoryContent(proposal.text)) return null;
  if (proposal.factKey && !/^(identity\.name|promise\.[\w.-]+|route\.[\w.-]+|preference\.[\w.-]+|episode\.[\w.-]+|summary\.[\w.-]+)$/.test(proposal.factKey)) return null;
  if (proposal.kind === 'promise' && !proposal.factKey?.startsWith('promise.')) return null;
  if (proposal.kind === 'reason' && !proposal.factKey?.startsWith('route.')) return null;
  if (!proposal.factKey && !['episode', 'summary'].includes(proposal.kind)) return null;
  const memoryId = stableUuid(`${input.campaignId}:${input.eventId}:${proposal.factKey ?? proposal.kind}`);
  const factKey = proposal.factKey ?? `${proposal.kind}.${memoryId}`;
  const expiresAt = proposal.expiresInSeconds ? new Date(Date.now()+proposal.expiresInSeconds*1000).toISOString() : undefined;
  return envelopeSchema.parse({ schemaVersion:1,memoryId,campaignId:input.campaignId,characterId:'mira',kind:proposal.kind,factKey,revision:1,text:proposal.text.trim(),source:{type:input.sourceType??'user',id:input.eventId},occurredAt:new Date().toISOString(),expiresAt });
}

/** Conservative local first-pass detector; semantic proposals must pass validateCandidateProposal before queueing. */
export function extractCandidate(input: { message: string; campaignId: string; eventId: string; revision?: number; sourceType?: 'user' | 'game' }) {
  const text = input.message.trim().replace(/\s+/g,' ');
  if (text.length > 500 || isUnsafeMemoryContent(text) || /\b(?:don't|do not|never)\s+(?:remember|save|store|keep)\b/i.test(text)) return null;
  const name = /\b(?:call me|my name is|actually use)\s+[^\s]/i.test(text);
  const temporaryWord = /\b(today|tonight|this session|for now|temporarily)\b/i.exec(text)?.[1];
  const promise = /\b(promise|meet|I'll|I will|we'll|we will)\b/i.test(text);
  const preference = Boolean(name) || /\b(prefer|I like)\b/i.test(text);
  const reason = /\b(because|since)\b/i.test(text) && /\b(route|ridge|tower|road|path|low)\b/i.test(text);
  const cue = Boolean(name) || /\b(remember|promise|meet|call me|my name is|actually use|I prefer|I like|because|since)\b/i.test(text);
  if (!cue || (!promise && !preference && !reason)) return null;
  const kind = promise ? 'promise' : preference ? 'preference' : 'reason';
  const preferenceDetail = text.toLocaleLowerCase().match(/(?:prefer|like)\s+([\p{L}\p{N} -]{1,32})/u)?.[1]?.trim().replace(/\s+/g,'-') ?? 'unspecified';
  const factKey = name ? 'identity.name' : promise ? 'promise.meeting' : reason ? 'route.reason' : `preference.${preferenceDetail}`;
  const expiresAt = temporaryWord ? new Date(Date.now()+(temporaryWord.toLowerCase()==='tonight'?8:24)*60*60*1000).toISOString() : undefined;
  return envelopeSchema.parse({ schemaVersion:1,memoryId:stableUuid(`${input.campaignId}:${input.eventId}:${factKey}`),campaignId:input.campaignId,characterId:'mira',kind,factKey,revision:input.revision??1,text,source:{type:input.sourceType??'user',id:input.eventId},occurredAt:new Date().toISOString(),expiresAt });
}
