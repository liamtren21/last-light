import { createHmac } from 'node:crypto';
import { config } from '../config';

export function opaqueNamespace(userId: string, campaignId: string, characterId = 'mira', factKey?: string, revision?: number) {
  const secret = config.sessionSecret;
  if (!secret) throw new Error('SESSION_SECRET_REQUIRED_FOR_MEMORY_SCOPE');
  const scope = createHmac('sha256', secret).update(`${userId}:${campaignId}:${characterId}`).digest('hex').slice(0, 40);
  const suffix = factKey && revision ? `-${createHmac('sha256', secret).update(factKey).digest('hex').slice(0, 8)}-r${revision}` : '';
  return `ll-${scope}${suffix}`;
}

export function factHash(factKey: string) {
  const secret = config.sessionSecret;
  if (!secret) throw new Error('SESSION_SECRET_REQUIRED_FOR_MEMORY_SCOPE');
  return createHmac('sha256', secret).update(factKey).digest('hex');
}
