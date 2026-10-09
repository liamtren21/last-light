import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { app } from '../../server/index';
import { migrate, pool } from '../../server/db';

const post = (path: string, cookie = '', body: unknown = {}, headers: Record<string, string> = {}) => app.request(path, {
  method: 'POST',
  headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function guest() {
  const response = await post('/api/session');
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const row = await pool!.query('SELECT user_id,campaign_id FROM sessions WHERE token_hash=$1', [hash(token)]);
  return { cookie, token, userId: row.rows[0].user_id as string, campaignId: row.rows[0].campaign_id as string };
}

describe.skipIf(!process.env.LAST_LIGHT_DATABASE_TEST)('auth and tenant isolation matrix (dedicated PostgreSQL)', () => {
  beforeAll(async () => {
    if (!pool) throw new Error('DATABASE_REQUIRED');
    await migrate();
  });
  afterAll(async () => { await pool?.end(); });

  it('01 denies unauthenticated game reads', async () => {
    expect((await app.request('/api/game')).status).toBe(401);
  });
  it('02 denies unauthenticated state-changing actions', async () => {
    expect((await post('/api/actions', '', { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID() })).status).toBe(401);
  });
  it('03 denies an unknown cookie token', async () => {
    expect((await app.request('/api/game', { headers: { cookie: 'last_light_session=not-a-session' } })).status).toBe(401);
  });
  it('04 denies an expired persisted session', async () => {
    const user = await guest();
    await pool!.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1', [hash(user.token)]);
    expect((await app.request('/api/game', { headers: { cookie: user.cookie } })).status).toBe(401);
  });
  it('05 gives each guest a distinct persisted user and campaign', async () => {
    const [a, b] = await Promise.all([guest(), guest()]);
    expect(a.userId).not.toBe(b.userId);
    expect(a.campaignId).not.toBe(b.campaignId);
  });
  it('06 ignores a client-supplied victim campaign when changing story state', async () => {
    const [attacker, victim] = await Promise.all([guest(), guest()]);
    const result = await post('/api/actions', attacker.cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID(), campaignId: victim.campaignId });
    expect(result.status).toBe(200);
    const victimState = await app.request('/api/game', { headers: { cookie: victim.cookie } });
    expect((await victimState.json()).state.version).toBe(0);
  });
  it('07 ignores a client-supplied victim user ID', async () => {
    const [attacker, victim] = await Promise.all([guest(), guest()]);
    await post('/api/actions', attacker.cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID(), userId: victim.userId });
    expect((await (await app.request('/api/game', { headers: { cookie: victim.cookie } })).json()).state.version).toBe(0);
  });
  it('08 ignores a client-supplied memory namespace', async () => {
    const user = await guest();
    const response = await post('/api/actions', user.cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID(), namespace: 'victim-private-namespace' });
    expect(response.status).toBe(200);
    expect((await pool!.query('SELECT count(*)::int AS n FROM memory_outbox WHERE user_id=$1', [user.userId])).rows[0].n).toBe(0);
  });
  it('09 rejects a stale expected game version', async () => {
    const user = await guest();
    const response = await post('/api/actions', user.cookie, { choiceId: 'ask-map', expectedVersion: -1, clientActionId: crypto.randomUUID() });
    expect(response.status).toBe(409);
  });
  it('10 rejects a future expected game version', async () => {
    const user = await guest();
    expect((await post('/api/actions', user.cookie, { choiceId: 'ask-map', expectedVersion: 99, clientActionId: crypto.randomUUID() })).status).toBe(409);
  });
  it('11 rejects a malformed action id before writing an event', async () => {
    const user = await guest();
    expect((await post('/api/actions', user.cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: 'attacker-id' })).status).toBe(400);
    expect((await pool!.query('SELECT count(*)::int AS n FROM game_events WHERE campaign_id=$1', [user.campaignId])).rows[0].n).toBe(0);
  });
  it('12 replays the same action ID as the same persisted result', async () => {
    const user = await guest(); const clientActionId = crypto.randomUUID();
    const body = { choiceId: 'ask-map', expectedVersion: 0, clientActionId };
    const first = await post('/api/actions', user.cookie, body);
    const replay = await post('/api/actions', user.cookie, body);
    expect(first.status).toBe(200); expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect((await pool!.query('SELECT count(*)::int AS n FROM game_events WHERE campaign_id=$1 AND id=$2', [user.campaignId, clientActionId])).rows[0].n).toBe(1);
  });
  it('13 scopes the same action ID independently across campaigns', async () => {
    const [a, b] = await Promise.all([guest(), guest()]); const id = crypto.randomUUID();
    const body = { choiceId: 'ask-map', expectedVersion: 0, clientActionId: id };
    expect((await post('/api/actions', a.cookie, body)).status).toBe(200);
    expect((await post('/api/actions', b.cookie, body)).status).toBe(200);
    expect((await pool!.query('SELECT count(*)::int AS n FROM game_events WHERE id=$1', [id])).rows[0].n).toBe(2);
  });
  it('14 rejects recovery restore without a session cookie as an auth bypass', async () => {
    const response = await post('/api/recovery/restore', '', { code: 'x'.repeat(32) });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('15 makes a recovery code one-use even across simultaneous restores', async () => {
    const user = await guest(); const created = await post('/api/recovery/create', user.cookie); const { code } = await created.json() as { code: string };
    const attempts = await Promise.all([post('/api/recovery/restore', '', { code }), post('/api/recovery/restore', '', { code })]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401]);
  });
  it('16 rotates the prior recovery code when creating a replacement', async () => {
    const user = await guest();
    const first = await (await post('/api/recovery/create', user.cookie)).json() as { code: string };
    const second = await (await post('/api/recovery/create', user.cookie)).json() as { code: string };
    expect((await post('/api/recovery/restore', '', { code: first.code })).status).toBe(401);
    expect((await post('/api/recovery/restore', '', { code: second.code })).status).toBe(200);
  });
  it('17 revokes an issued recovery code', async () => {
    const user = await guest(); const { code } = await (await post('/api/recovery/create', user.cookie)).json() as { code: string };
    expect((await post('/api/recovery/revoke', user.cookie)).status).toBe(200);
    expect((await post('/api/recovery/restore', '', { code })).status).toBe(401);
  });
  it('18 rejects malformed recovery IDs without creating a session', async () => {
    const response = await post('/api/recovery/restore', '', { code: 'short' });
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('19 rejects an untrusted browser origin on writes', async () => {
    const user = await guest();
    const response = await post('/api/campaigns/new', user.cookie, {}, { origin: 'https://unrelated.example' });
    expect(response.status).toBe(403);
    const saved=await app.request('/api/game', { headers: { cookie: user.cookie } });
    expect((await saved.json()).state.version).toBe(0);
  });
  it('20 rejects cross-site writes when Origin is absent', async () => {
    const user = await guest();
    const response = await post('/api/campaigns/new', user.cookie, {}, { 'sec-fetch-site': 'cross-site' });
    expect(response.status).toBe(403);
  });
});
