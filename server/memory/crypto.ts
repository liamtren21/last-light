import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';

function key() {
  if (!config.sessionSecret || config.sessionSecret.length < 32) throw new Error('SESSION_SECRET_MUST_BE_32_CHARACTERS');
  return createHash('sha256').update(config.sessionSecret).digest();
}
export function encryptPayload(value: string) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function decryptPayload(payload: string) {
  const bytes = Buffer.from(payload, 'base64url'); const nonce = bytes.subarray(0, 12); const tag = bytes.subarray(12, 28); const ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
